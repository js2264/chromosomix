/**
 * The contact-map canvas.
 *
 * Technique is fixed by spec §7.2 and by the scale assumption in §2: build an
 * `ImageData` **at matrix resolution**, `putImageData` it to an offscreen
 * canvas once, then `drawImage` that offscreen canvas through a transform onto
 * the display canvas. Pan and zoom only change the transform, so they perform
 * **zero** I/O and zero re-rasterisation — which is the whole reason the app
 * needs no tile server, no LRU cache and no progressive refinement.
 *
 * Re-rasterising happens on exactly three events: a new matrix, a new colour
 * scale, or a new colormap. Never on pan, never on zoom, never on resize.
 */

import { MAX_CATEGORICAL_TICKS } from '../constants'
import type { ColorScale, DenseMatrix, Separator, Transform } from '../types'
import { applyColormap, colormapIndex } from './colormaps'
import { anchorRays, turnedCentre, type RotateDirection } from './rotate'
import {
  Scale,
  autoRangeOfDisplay,
  autoSymmetricRange,
  displayValue,
  transformValue,
  type ValueRange,
} from './scale'

// ---------------------------------------------------------------------------
// Rasterisation — pure, no canvas, so it is testable under Node
// ---------------------------------------------------------------------------

/** RGBA bytes at matrix resolution, plus the colour scale actually used. */
export interface Raster {
  /** Raster columns — matrix columns divided by {@link stride}. */
  width: number
  /** Raster rows — matrix rows divided by {@link stride}. */
  height: number
  /** `width * height * 4` bytes, row-major, ready for `new ImageData(...)`. */
  data: Uint8ClampedArray
  /** The scale with `vmin`/`vmax` resolved, so the colourbar can reuse it. */
  scale: ColorScale
  /**
   * Matrix cells per raster pixel, **per axis**. `1` for an axis that fits.
   *
   * A whole yeast genome at 1 kb is 12,100 bins: rasterising it one pixel per
   * bin would be 585 MB of RGBA and a canvas of the same size again, for an
   * image no screen can show. Above {@link RASTER_MAX_DIM} the raster is
   * pooled instead, and the caller multiplies its draw transform by these.
   *
   * Two numbers, not one: a 600 × 8,141 genome pair — the shape every pair
   * involving a large MAG has — would otherwise halve the 600-bin axis to
   * match the axis that actually needed pooling, losing resolution nothing was
   * asking for and saving nothing. The two axes of such a block are two
   * *different sequences*, so there is nothing to keep in step between them.
   *
   * **A turned band is the exception, and it is asked for by name** (`isotropic`
   * in {@link poolDisplay}). The rotation is isometric — a base pair up the side
   * is the same length as one along the bottom (`render/rotate.ts`) — so a raster
   * pixel that covers four cells across and two up is drawn as a rectangle where
   * the geometry promises a square. Everything downstream then has one decision
   * to make about two different scales: the filter is chosen for both axes at
   * once, so at the crossover x is *magnified* through a blur while y is still
   * minified with point sampling, and past it nearest neighbour lays down cells
   * two device pixels wide and one tall. Against a picture whose structure runs
   * at 45° that reads as a staircase of smeared diagonals — the aliasing a reader
   * sees when they scroll into a band on a long chromosome.
   */
  strideX: number
  strideY: number
}

/**
 * The largest raster the renderer will build, per axis.
 *
 * Chosen well below every browser's canvas cap (Firefox stops at 32,767 px per
 * side, Chrome's *area* cap is 2^28 px) and above any display: 4096 px is more
 * than 4K across, so pooling above it costs no visible detail at fit zoom, and
 * a zoomed-in view of a pooled block re-rasterises nothing because pooling is
 * per matrix, not per view. It caps the two allocations that scale with the
 * *picture* rather than with the data: 67 MB of RGBA and 67 MB of canvas.
 */
export const RASTER_MAX_DIM = 4096

/** Matrix cells per raster pixel needed to fit one axis of `n` in the cap. */
export function rasterStride(n: number, maxDim = RASTER_MAX_DIM): number {
  return n <= maxDim ? 1 : Math.ceil(n / maxDim)
}

/**
 * Colour every cell of `matrix` into RGBA bytes.
 *
 * Either bound is honoured when finite and resolved by {@link autoRangeOf}
 * otherwise — pass `NaN` for both to ask for the `metacooler show` default.
 * They resolve *together*, because the fallback rule the CLI never reaches
 * moves both: a `vmin` pinned at `0` beside an auto `vmax` is what made `log10`
 * of a balanced matrix come out blank.
 *
 * NaN cells come out fully transparent rather than as a colour. That is
 * matplotlib's default "bad" colour and it is the diagnostically correct
 * result: a blank row is an unbalanced row (spec §6.4), and painting it black
 * or white would make it indistinguishable from a genuinely empty region.
 */
export function rasterize(
  matrix: DenseMatrix,
  scale: ColorScale,
  options: { maxDim?: number } = {},
): Raster {
  return colorize(poolDisplay(matrix, scale, options), scale)
}

/**
 * One display value per raster pixel, plus the extent of the drawable ones.
 *
 * This is the only pass over the matrix, and it is what the two steps after it
 * work from. Splitting it out is what makes a colour change cheap: the pooled
 * values depend on the matrix, the transform and whether it is balanced, and on
 * nothing else, so changing a colormap or dragging a clip handle re-colours a
 * few million pooled pixels instead of re-scanning a hundred million cells.
 */
export interface PooledDisplay {
  width: number
  height: number
  strideX: number
  strideY: number
  /**
   * Whether the two strides were held equal; part of the cache key.
   *
   * A turned band asks for it and nothing else does, so this is also how the
   * cache knows that pressing the turn toggle invalidates a pooling whose
   * numbers, transform and balancing have not moved at all.
   */
  isotropic: boolean
  /** `width * height` display values; `NaN` where nothing was drawable. */
  values: Float32Array
  /** What the pooling was computed for; the cache key. */
  transform: Transform
  balanced: boolean
  /**
   * The neutral value in **display** units, or `null` for an ordinary
   * one-ended quantity. Part of the cache key like the two above: it decides
   * both the reduction that produced {@link values} and the auto range read off
   * them.
   */
  centre: number | null
  /**
   * The auto range over {@link values}, memoised by {@link colorize} on first
   * demand.
   *
   * It depends on the pooled values, the transform and whether they are
   * balanced — the three things that are already this object's identity — and
   * on nothing the colormap or the clip can change. Recomputing it per
   * `colorize` call meant every colormap change re-derived a pair of numbers it
   * already had, which on a dense 4,096² raster is the difference between a
   * repaint and a two-second freeze.
   */
  autoRange?: ValueRange
}

/**
 * Whether the maximum of a block can be taken *before* the transform.
 *
 * The pooled value is the largest display value in the block, and where the
 * transform is monotone in the raw value that is the transform of the largest
 * raw value — the same element, so the same bits. Taking it that way applies
 * `displayValue` once per raster pixel instead of once per matrix cell, which
 * on a whole yeast genome at 500 bp is 16.4 M calls instead of 592 M.
 *
 * The exception is `log10` on **raw counts**, whose `x > 0 ? log10(x) : 0` clamp
 * is not monotone across zero: `f(0)` is `0` while `f(0.5)` is negative. Integer
 * counts never land in `(0, 1)` so it would be safe for them, but a float count
 * column can, and "safe for the data I happened to test" is not a property worth
 * having — that path keeps transforming per cell. Balanced `log10` sends zero to
 * `-Infinity` instead and *is* monotone, and so are `log1p` and `none`.
 */
function poolsRawMax(transform: Transform, balanced: boolean): boolean {
  return transform !== 'log10' || balanced
}

export function poolDisplay(
  matrix: DenseMatrix,
  scale: ColorScale,
  options: { maxDim?: number; isotropic?: boolean } = {},
): PooledDisplay {
  const { nrows, ncols, values } = matrix
  const balanced = scale.balanced === true
  const transform = scale.transform

  const maxDim = options.maxDim ?? RASTER_MAX_DIM
  const perAxis = { x: rasterStride(ncols, maxDim), y: rasterStride(nrows, maxDim) }
  // One stride for both axes where the caller says the block's two axes are the
  // same measure — which is a turned band, and only a turned band. See
  // {@link Raster.strideX} for what a rectangular raster pixel does to a picture
  // whose geometry promises square ones, and why a genome pair wants the
  // opposite. The larger of the two, because a stride is the *floor* on what fits.
  const common = Math.max(perAxis.x, perAxis.y)
  const isotropic = options.isotropic === true
  const strideX = isotropic ? common : perAxis.x
  const strideY = isotropic ? common : perAxis.y
  const width = Math.ceil(ncols / strideX)
  const height = Math.ceil(nrows / strideY)
  const pooled = new Float32Array(width * height)
  // A neutral value only *has* a middle if it survives the transform. `log2` of
  // a difference map's neutral `0` is `-Infinity`, which is not a position on
  // the scale and would make every departure from it infinite; there the field
  // is drawn by the ordinary rules, which is the honest outcome — a signed
  // difference has no logarithm to be symmetric about.
  const centreRaw = scale.neutral === undefined ? null : transformValue(scale.neutral, transform)
  const centre = centreRaw !== null && Number.isFinite(centreRaw) ? centreRaw : null
  const pool: PooledDisplay = {
    width,
    height,
    strideX,
    strideY,
    isotropic,
    values: pooled,
    transform,
    balanced,
    centre,
  }

  // Nothing is pooled: a block small enough to draw a pixel per cell. The
  // general loop below still pays its four bounds and its NaN-max reduction for
  // every 1 × 1 "block", which measured 3.2x the cost per cell of the case where
  // it actually has something to reduce. Every MAG and every region view is
  // here, so it is worth the twelve lines.
  if (strideX === 1 && strideY === 1) {
    const n = nrows * ncols
    for (let i = 0; i < n; i++) pooled[i] = displayValue(values[i], transform, balanced)
    return pool
  }

  // A diverging field is pooled by *departure* from neutral rather than by
  // magnitude, and it cannot take the raw shortcut either. Both follow from the
  // same fact: `|display - centre|` and `|raw - neutral|` do not order the same
  // way across the two arms — under `log2` about 1, a cell of 4 is three away in
  // raw units and two away in display units, while a cell of 0.25 is 0.75 away
  // in raw and also two in display. Reducing on the raw distance would make the
  // arm above neutral win every tie and quietly erase the other one.
  const centreOf = pool.centre
  if (centreOf !== null) {
    for (let ry = 0; ry < height; ry++) {
      const y0 = ry * strideY
      const y1 = Math.min(y0 + strideY, nrows)
      for (let rx = 0; rx < width; rx++) {
        const x0 = rx * strideX
        const x1 = Math.min(x0 + strideX, ncols)
        // The farthest **finite** departure, with a non-finite one kept only
        // when the block holds nothing else. Without that restriction this
        // reduction erases the picture rather than summarising it: an empty
        // cell of a ratio field is `0`, whose `log2` is `-Infinity`, and a
        // contact map is mostly empty — so every pooled block would contain one
        // and infinity would win all of them. Measured on an 8,192-row sparse
        // ratio field, that put 0 of 32,768 pooled pixels at a finite value and
        // drew the whole map as one colour at fit zoom.
        //
        // The same rule the maximum path applies to NaN, for the same reason,
        // one step further: a value that cannot be compared must not out-rank
        // every value that can.
        let best = Number.NaN
        let far = -1
        let fallback = Number.NaN
        for (let y = y0; y < y1; y++) {
          const row = y * ncols
          for (let x = x0; x < x1; x++) {
            const raw = values[row + x]
            if (Number.isNaN(raw)) continue
            const t = displayValue(raw, transform, balanced)
            if (!Number.isFinite(t)) {
              // Off the end in one direction. Worth drawing where there is
              // nothing else in the block to draw, and never worth losing a
              // real reading for.
              if (Number.isNaN(fallback)) fallback = t
              continue
            }
            const away = Math.abs(t - centreOf)
            if (away > far) {
              far = away
              best = t
            }
          }
        }
        pooled[ry * width + rx] = Number.isNaN(best) ? fallback : best
      }
    }
    return pool
  }

  // The *maximum* over the pooled cells, not the mean. A contact map is sparse
  // and its signal is the bright cell; averaging it against its empty
  // neighbours is how a loop disappears at fit zoom. NaN is not a value to
  // maximise over — it means "unbalanced" — so it only survives when the whole
  // block is NaN, and then the cell stays transparent, as one NaN cell does.
  const rawMax = poolsRawMax(transform, balanced)
  for (let ry = 0; ry < height; ry++) {
    const y0 = ry * strideY
    const y1 = Math.min(y0 + strideY, nrows)
    for (let rx = 0; rx < width; rx++) {
      const x0 = rx * strideX
      const x1 = Math.min(x0 + strideX, ncols)
      let best = Number.NaN
      if (rawMax) {
        for (let y = y0; y < y1; y++) {
          const row = y * ncols
          for (let x = x0; x < x1; x++) {
            const raw = values[row + x]
            if (Number.isNaN(raw)) continue
            if (Number.isNaN(best) || raw > best) best = raw
          }
        }
        if (!Number.isNaN(best)) best = displayValue(best, transform, balanced)
      } else {
        for (let y = y0; y < y1; y++) {
          const row = y * ncols
          for (let x = x0; x < x1; x++) {
            const raw = values[row + x]
            if (Number.isNaN(raw)) continue
            const t = displayValue(raw, transform, balanced)
            if (Number.isNaN(best) || t > best) best = t
          }
        }
      }
      pooled[ry * width + rx] = best
    }
  }

  return pool
}

/**
 * Colour a pooled raster. Either bound is honoured when finite and resolved by
 * {@link autoRangeOfDisplay} otherwise — pass `NaN` for both to ask for the
 * `metacooler show` default.
 *
 * They resolve *together*, because the fallback rule the CLI never reaches
 * moves both: a `vmin` pinned at `0` beside an auto `vmax` is what made `log10`
 * of a balanced matrix come out blank.
 */
export function autoRangeOfPooled(pooled: PooledDisplay): ValueRange {
  // Memoised on the pooled block, because that is what it is a property of. A
  // colormap change cannot move it, and recomputing it there was the dominant
  // cost of the most common colour interaction there is.
  //
  // Symmetric about neutral where there is one. Reading a diverging field with
  // the ordinary rule puts the colour that means "these agree" at an arbitrary
  // point in the ramp, so a map of two identical files comes out uniformly
  // coloured rather than uniformly neutral.
  pooled.autoRange ??=
    pooled.centre === null
      ? autoRangeOfDisplay(pooled.values, pooled.transform, pooled.balanced)
      : autoSymmetricRange(pooled.values, pooled.centre)
  return pooled.autoRange
}

export function colorize(
  pooled: PooledDisplay,
  scale: ColorScale,
  into?: Uint8ClampedArray,
): Raster {
  const { width, height, values } = pooled
  const auto: ValueRange | null =
    Number.isFinite(scale.vmin) && Number.isFinite(scale.vmax) ? null : autoRangeOfPooled(pooled)
  const vmin = Number.isFinite(scale.vmin) ? scale.vmin : (auto?.vmin ?? 0)
  const vmax = Number.isFinite(scale.vmax) ? scale.vmax : (auto?.vmax ?? 1)
  const span = vmax - vmin

  const lut = applyColormap(scale.colormap)
  // Reused where the caller has a buffer of the right size — every recolour of
  // an unchanged block, which is the common case. A fresh 4 B/px allocation per
  // colormap click is 66 MB of garbage on a full-size raster, produced at the
  // exact moment the memory budget is tightest.
  const data =
    into !== undefined && into.length === width * height * 4
      ? into
      : new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < values.length; i++) {
    const best = values[i]
    const o = i * 4
    if (Number.isNaN(best)) {
      // Every byte is written on every path, including this one: the buffer may
      // be a reused one that still holds the previous colouring.
      data[o] = 0
      data[o + 1] = 0
      data[o + 2] = 0
      data[o + 3] = 0
      continue
    }
    // matplotlib's `Normalize` collapses a degenerate range to 0 rather than
    // dividing by zero, so a constant matrix renders as the colormap's low
    // end. `-Infinity` — a zero cell under `log10` of a balanced block — is
    // below every bound there is, which is that same low end.
    const k = colormapIndex(span > 0 && Number.isFinite(best) ? (best - vmin) / span : 0)
    if (k < 0) {
      data[o] = 0
      data[o + 1] = 0
      data[o + 2] = 0
      data[o + 3] = 0
      continue
    }
    const s = k * 4
    data[o] = lut[s]
    data[o + 1] = lut[s + 1]
    data[o + 2] = lut[s + 2]
    data[o + 3] = lut[s + 3]
  }

  return {
    width,
    height,
    data,
    scale: { ...scale, vmin, vmax },
    strideX: pooled.strideX,
    strideY: pooled.strideY,
  }
}

// ---------------------------------------------------------------------------
// Separators and labels
// ---------------------------------------------------------------------------

/**
 * Boundary lines for both axes.
 *
 * `Separator.at` is the **first cell of the block it labels**, so a fully
 * labelled axis includes an entry at `0`. A line is drawn at every `at`
 * strictly inside the block — the edge at `0` is the block edge and needs no
 * line — and a leading block with no separator at `0` is drawn but not
 * labelled.
 *
 * `rows`/`cols` are the hairlines at contig (or genome-row) boundaries;
 * `groupRows`/`groupCols` are the heavier lines `ops/show.py` draws between the
 * blocks of a multi-name selection, where the block structure is the thing the
 * reader came to see.
 */
export interface SeparatorSet {
  rows: Separator[]
  cols: Separator[]
  groupRows?: Separator[]
  groupCols?: Separator[]
}

/** A run of consecutive cells sharing one label, derived from separators. */
export interface LabelBlock {
  start: number
  /** Exclusive. */
  end: number
  label: string
}

const EMPTY_SEPARATORS: SeparatorSet = { rows: [], cols: [] }

/**
 * Turn separator positions into labelled blocks. Separators outside `[0, n)`
 * are dropped and each block runs to the next separator or to the end of the
 * axis.
 */
/**
 * Where a block's name goes: the middle of the part of it that is on screen.
 *
 * The block's own midpoint only works while the whole block is in view, which
 * it was when labels were drawn only on axes small enough to fit. Zoomed in, a
 * genome block can be wider than the window and its midpoint is then off the
 * canvas — the name of the thing filling the picture was the one name not
 * written on it.
 */
export function visibleCentre(
  block: { start: number; end: number },
  domain: readonly [number, number],
): number {
  const start = Math.max(block.start, domain[0])
  const end = Math.min(block.end, domain[1])
  return end > start ? (start + end) / 2 : (block.start + block.end) / 2
}

/**
 * The first index in `[0, length)` for which `pred` holds, or `length`.
 * `pred` must be monotone: false, then true.
 */
function lowerBound(length: number, pred: (index: number) => boolean): number {
  let lo = 0
  let hi = length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pred(mid)) hi = mid
    else lo = mid + 1
  }
  return lo
}

export function separatorBlocks(seps: readonly Separator[], n: number): LabelBlock[] {
  const inside = seps
    .filter((s) => s.at >= 0 && s.at < n)
    .slice()
    .sort((a, b) => a.at - b.at)
  const out: LabelBlock[] = []
  for (let i = 0; i < inside.length; i++) {
    const start = inside[i].at
    const end = i + 1 < inside.length ? inside[i + 1].at : n
    if (end > start) out.push({ start, end, label: inside[i].label })
  }
  return out
}

// ---------------------------------------------------------------------------
// Canvas plumbing
// ---------------------------------------------------------------------------

type RasterCanvas = HTMLCanvasElement | OffscreenCanvas

/**
 * How many halvings of the raster the view will keep; see
 * {@link HeatmapView.rasterFor}.
 *
 * Four is a sixteen-fold reduction, which is a whole yeast genome at 500 bp in a
 * thumbnail. Past it the level is smaller than the plot's own margins and there
 * is nothing left to filter.
 */
const MAX_RASTER_LEVELS = 4

/** Below this many pixels on an axis, a level is not halved again. */
const MIN_RASTER_LEVEL = 8

/**
 * One level of the pyramid: `from`, averaged down by two on both axes.
 *
 * The averaging is the canvas's own, and at exactly one half a bilinear tap
 * *is* the mean of the 2 × 2 block it covers — which is why this is the one
 * reduction the filter can be trusted with, and why the pyramid is built out of
 * halvings rather than by scaling straight to the size wanted. Transparency
 * averages with everything else, so the empty corners of a turned block stay
 * empty and the cells beside them are not dimmed towards paper.
 *
 * `null` where the platform hands back no context, which the caller answers by
 * drawing from the level above — a softer picture, never a missing one.
 */
function halveRaster(from: RasterCanvas): RasterCanvas | null {
  const width = Math.max(1, Math.ceil(from.width / 2))
  const height = Math.max(1, Math.ceil(from.height / 2))
  const canvas = createRasterCanvas(width, height)
  const ctx = (canvas as HTMLCanvasElement).getContext('2d')
  if (ctx === null) return null
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(from as CanvasImageSource, 0, 0, from.width, from.height, 0, 0, width, height)
  return canvas
}

/**
 * A canvas sized to the matrix, for the `putImageData` step. `OffscreenCanvas`
 * where it exists (it does in every browser the app targets, and in workers);
 * a detached `<canvas>` otherwise.
 */
function createRasterCanvas(width: number, height: number): RasterCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    return c
  }
  throw new Error(
    'HeatmapView needs OffscreenCanvas or a DOM document; use rasterize() directly under Node.'
  )
}

/**
 * How long a click waits to see whether it is the first half of a double one.
 * The platform value is not exposed to script, and 250 ms is what every toolkit
 * uses when it has to guess.
 */
const DOUBLE_CLICK_MS = 250

/**
 * How long a freeze lasts before it shows a spinner.
 *
 * Most refines are served out of the byte source's chunk cache and land in a few
 * milliseconds; a spinner that flashed on every one would be noise about
 * something that did not happen. Long enough that a cached read is silent, short
 * enough that a real one is announced before the reader wonders.
 */
const SPINNER_DELAY_MS = 140

/** The spinner's ring radius, and how far its disc sits off the plot corner. */
const SPINNER_RADIUS = 9
const SPINNER_INSET = 10

/** `performance.now` where there is one, so a spinner turns evenly. */
function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

/**
 * `requestAnimationFrame`, where there is one.
 *
 * There is not, in two places this class already runs: the export path builds a
 * view against an offscreen canvas, and the test suite runs under Node. Neither
 * has anything to animate, so the honest answer is not to schedule — a spinner
 * that never turns is exactly right for a figure and for a headless draw, and
 * the alternative is a `ReferenceError` from a decoration.
 */
function frameLoop(run: () => void): number | null {
  return typeof requestAnimationFrame === 'undefined' ? null : requestAnimationFrame(run)
}

function cancelFrameLoop(handle: number): void {
  if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(handle)
}

/** Space reserved outside the plot area for tick labels, in CSS pixels. */
export interface Margin {
  top: number
  right: number
  bottom: number
  left: number
}

/** The plot area in CSS pixels, relative to the canvas origin. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** One axis of a dragged box, as the three numbers written beside it. */
export interface SelectionSpanText {
  start: string
  end: string
  span: string
}

/** Both axes of a dragged box; `null` where an axis has no coordinates. */
export interface SelectionText {
  rows: SelectionSpanText | null
  cols: SelectionSpanText | null
}

/**
 * A dragged selection, in the coordinates the caller thinks in.
 *
 * Offsets are block-local, as {@link Cell.row} is, because that is what
 * `groupAt` and the base-pair arithmetic take. The anchor is the cell the drag
 * *started* on, which is what says which contig or genome the selection is of:
 * a square laid across a boundary belongs to the block it was begun in, not to
 * whichever one happens to hold more of its area.
 */
export interface SelectionBox {
  /** Half-open row range, clamped to the block. */
  rows: [number, number]
  /** Half-open column range, clamped to the block. */
  cols: [number, number]
  /** Where the drag began. */
  anchor: Cell
}

/** A cell identified by {@link HeatmapView.cellAt}. */
export interface Cell {
  /** Row within the rendered block. */
  row: number
  /** Column within the rendered block. */
  col: number
  /**
   * Absolute row index, i.e. `matrix.rowExtent[0] + row`. At bin level that is
   * a bin id; at contig or genome level it is a contig or genome index. Either
   * way it is what the §5.5 "click an off-diagonal cell" navigation needs, and
   * it is never renumbered to hide `__unbinned__` (§7.4).
   */
  rowBin: number
  /** Absolute column index, `matrix.colExtent[0] + col`. */
  colBin: number
  /** The raw, untransformed value. NaN for an unbalanced cell. */
  value: number
}

/**
 * What the plot draws over the pixels, toggled from the view card.
 *
 * All four are pure overlay: nothing here re-reads, re-rasterises or changes
 * the data, so a toggle costs one repaint of an image that is already in
 * memory. `dividers`, `labels` and `ticks` start on because they match
 * `metacooler show`; `crosshair` starts off because a line that follows the
 * pointer is help while you are aiming and clutter while you are reading.
 */
export interface PlotOptions {
  /**
   * Text *on the tracks*: their names, their value ranges, and the names of the
   * features in them.
   *
   * The matrix ignores it — its own labels are `labels` and `ticks` — but the
   * option lives here because it is one of the same kind of thing, and because
   * a figure is a figure: the moment a track lane is the picture rather than a
   * caption beside one, every word drawn into it is ink somebody may want out.
   */
  text: boolean
  /**
   * The shaded area under a value track's line.
   *
   * Two fills, one switch, because they are one thing to the eye: the pale
   * envelope that says what a zoomed-out mean hid, and the area an `area` track
   * carries under its own line. Both are context for the line rather than a
   * second series, and both stop being context the moment three tracks share a
   * lane — at which point what a reader wants is three lines.
   *
   * The matrix ignores it, like `text`, and for the same reason: it is an option
   * about the *tracks*, and the tracks are drawn beside a map as often as they
   * are drawn without one.
   */
  fills: boolean
  /**
   * A rule along each track lane's floor — its outer edge, not its origin.
   *
   * What tells four stacked coverage tracks apart from one tall one. Like
   * `text` and `fills` it is an option about the *tracks*, and the tracks are
   * drawn beside a map as often as they are drawn without one.
   */
  baseline: boolean
  /**
   * A dark rule along the top of every track, over its own colour.
   *
   * What a filled area is missing when it is read as a *shape* rather than as a
   * value at a position: the boundary between the ink and the paper is the only
   * part of an area track carrying information, and drawn in the track's own
   * colour it is the one edge of the fill that does not stand out from it. In
   * the plot's ink it does, and four stacked areas become four legible outlines.
   *
   * Off by default, because it is a claim about how the figure is read rather
   * than about the data, and a coloured area is the honest default for a track
   * whose colour is its identity.
   */
  outline: boolean
  /**
   * A column for the track names, with the tracks starting after it.
   *
   * A name drawn *over* a track is a name in the way of the data on every lane
   * whose first kilobase is the interesting one, and moving it is not free: the
   * axis has to start where the names end, or the name column would simply be a
   * second thing drawn on top. So this shifts the genomic axis, which is why it
   * is a preference and not a piece of styling.
   *
   * Beside a map it does nothing, and must not: a lane there is drawn in the
   * matrix's own coordinates, and a lane that started somewhere else would no
   * longer be under the column it describes. It is stored with the other track
   * options because it is one, and offered only where it applies (§8.4).
   */
  gutter: boolean
  /** Contig and genome boundary hairlines. */
  dividers: boolean
  /**
   * Boundary marks *outside* the data, along the top and left edges.
   *
   * The same information the dividers carry, drawn where it costs no data. On a
   * whole-genome map the question "where does one genome end" is asked
   * constantly and answered badly by both alternatives: hairlines across the
   * picture cover the contacts being read, and names need a gutter and thin out
   * to nothing once there are more of them than the axis can spell. A tick on
   * the edge is neither — it marks every boundary at any count, and it is off
   * the data by construction.
   */
  breaks: boolean
  /** Block labels in the gutters. Off also collapses the gutters they need. */
  labels: boolean
  /** Guide lines through the hovered cell. */
  crosshair: boolean
  /**
   * The card that follows the pointer, naming what is under it.
   *
   * A preference and not a fixed part of the view, because the two things a
   * reader does with a contact map want opposite answers. Reading it — what is
   * this cell, what are these tracks worth here — is the tooltip's whole reason
   * to exist. *Looking* at it, which is what somebody does while framing a
   * figure or showing it to another person, is a thing the card is directly in
   * the way of: it covers a few hundred square pixels of the picture wherever
   * the hand happens to be resting.
   *
   * The status line under the window says the same thing without covering
   * anything, so nothing is lost by turning this off — which is what makes it a
   * toggle rather than a compromise.
   *
   * The renderer itself draws no tooltip; this is read by the two panels that
   * own one. It lives here because it is one of the same kind of thing and
   * because both surfaces have to agree about it (`ui/plotOptions.ts`).
   */
  tooltip: boolean
  /** Base-pair coordinates along an axis that has a single one (§7.1). */
  ticks: boolean
}

/**
 * The guide-line colour, shared with whatever else continues the crosshair.
 *
 * Exported because the annotation lanes draw the same line through the same
 * column: two constants would be two colours the day one of them was tuned.
 */
export const CROSSHAIR_COLOR = '#1f5fa9'

/**
 * Half the length of the cross another panel's pointer leaves, in CSS pixels.
 *
 * About the size of a cursor: big enough to find at a glance on a busy map,
 * small enough that five of them are five marks rather than a grid.
 */
const ECHO_ARM = 5

export const DEFAULT_PLOT_OPTIONS: PlotOptions = {
  text: true,
  fills: true,
  baseline: true,
  outline: false,
  // Off in a figure: `metacooler show` draws no name column, and a lane drawn
  // beside a matrix cannot have one at all.
  gutter: false,
  dividers: true,
  breaks: true,
  labels: true,
  crosshair: false,
  // On: a figure has no pointer, so this costs a saved plot nothing, and the
  // renderer's defaults are read by views that then hand them to a panel.
  tooltip: true,
  ticks: true,
}

// ---------------------------------------------------------------------------
// Base-pair ticks
// ---------------------------------------------------------------------------

/**
 * How one axis of the block maps to base pairs, when it has a single
 * coordinate system to map to.
 *
 * A bin index is not a position: it counts from the left edge of the *picture*,
 * and `contig:139005-199005` starts at bin 139 of its contig, not at bin 0. So
 * the mapping is stated as a line — the position of the block's first cell, and
 * the width of a cell — which is exactly the arithmetic the hover readout does
 * (`MatrixPanel.bpWithin`), from the same two numbers.
 *
 * `null` for an axis that spans more than one contig, where the ticks are the
 * contig names instead; `_bin_axis` in `ops/show.py` draws the same distinction
 * and for the same reason.
 */
export interface AxisCoords {
  /** Base pairs per matrix cell — the bin size. */
  bpPerCell: number
  /** Base-pair position of the first cell of the block. */
  bpAtOrigin: number
  /**
   * On-screen room one label needs before another may be placed, in CSS pixels.
   *
   * {@link TICK_MIN_GAP_PX} unless given, which is the width of a bp label plus
   * air — the right figure for a ruler read left to right, and four times too
   * coarse for one read bottom to top, where a label is a line of type and
   * fifteen pixels apart is legible.
   *
   * It matters for exactly one ruler and it matters completely: a turned map's
   * band is a hundred pixels tall, which at the horizontal spacing is one tick,
   * on the diagonal, in the corner the column labels have already claimed — so
   * the axis that is the whole reason to turn the picture came out blank.
   */
  tickGapPx?: number
}

export interface AxisCoordSet {
  rows: AxisCoords | null
  cols: AxisCoords | null
}

/** Position ticks per axis, as `_MAX_POSITION_TICKS` in `ops/show.py`. */
export const MAX_POSITION_TICKS = 6

/** On-screen room one tick label needs before another may be placed. */
const TICK_MIN_GAP_PX = 78

/** Length of a tick mark, drawn inward from the data edge, in CSS pixels. */
const TICK_LENGTH = 5

/**
 * A round step covering `span` base pairs in at most `maxTicks` intervals.
 *
 * The 1–2–5 ladder, so a step is a number a reader recognises as a position
 * rather than as an artefact of the window width. Never finer than one bin: a
 * tick between two bins marks a coordinate no cell on screen has.
 */
export function chooseBpStep(span: number, maxTicks: number, bpPerCell = 1): number {
  if (!(span > 0) || maxTicks < 1) return Number.NaN
  const raw = span / maxTicks
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10
  return Math.max(step, bpPerCell)
}

/**
 * The ticks visible in `domain`, a half-open range of matrix coordinates.
 *
 * Positions are multiples of the step in *genomic* space, not offsets from the
 * left edge of the view, which is what keeps a tick on the same base pair while
 * the picture moves underneath it.
 */
export function bpTicks(
  coords: AxisCoords,
  domain: readonly [number, number],
  maxTicks: number,
): Array<{ bp: number; unit: number }> {
  const near = coords.bpAtOrigin + domain[0] * coords.bpPerCell
  const far = coords.bpAtOrigin + domain[1] * coords.bpPerCell
  // A **descending** axis is not a special case so much as a turned one: up the
  // side of a turned map, distance from the diagonal grows towards the top of
  // the picture while a row index grows towards the bottom, so `bpPerCell` is
  // negative and the two ends arrive the other way round. Order them and the
  // ladder below is the ladder it always was; `unit` inverts the same line
  // either way.
  const lo = Math.min(near, far)
  const hi = Math.max(near, far)
  const step = chooseBpStep(hi - lo, maxTicks, Math.abs(coords.bpPerCell))
  if (!Number.isFinite(step) || step <= 0) return []
  const out: Array<{ bp: number; unit: number }> = []
  // `+ 0` normalises the negative zero `Math.ceil` returns for a `lo` just
  // below the origin — which a turned map's ruler has, its band reaching half a
  // bin past the diagonal.
  const first = Math.ceil(lo / step) * step + 0
  for (let bp = first; bp <= hi; bp += step) {
    out.push({ bp, unit: (bp - coords.bpAtOrigin) / coords.bpPerCell })
    // The ladder bounds this at `maxTicks + 1`; the guard is against a
    // pathological `bpPerCell` making `step` too small to terminate usefully.
    if (out.length > maxTicks + 2) break
  }
  return out
}

/**
 * `0 bp`, `120 kb`, `1.5 Mb` — `_format_bp` in `ops/show.py`, digit for digit,
 * so the same position is written the same way in a figure and on screen.
 *
 * **A ruler passes the gap between its ticks**, and that is what stops a zoom
 * running out of digits. Two decimals of a megabase is ten kilobases, so on a
 * 4.6 Mb chromosome every tick of a twenty-kilobase window read `4.60 Mb` — a
 * column of identical numbers under a picture whose whole purpose at that zoom
 * is to say *where*. Given the step, the unit is chosen so that two decimals
 * can tell one tick from the next and the unit steps down when they cannot:
 * `4.6 Mb` at whole-chromosome zoom, `4605 kb` at five-kilobase ticks,
 * `4601520 bp` at ten. Without it the spelling is unchanged, which is what the
 * paragraph above promises about a lone position.
 */
export function formatBpTick(position: number, step?: number): string {
  for (const [scale, unit] of [
    [1e6, 'Mb'],
    [1e3, 'kb'],
  ] as const) {
    if (Math.abs(position) < scale) continue
    if (step === undefined) return `${trimZeros((position / scale).toFixed(2))} ${unit}`
    // How many decimals of this unit the gap between two ticks needs. A step of
    // 5 kb is 0.005 Mb and wants three, which is a number nobody reads off an
    // axis — so the unit gives way rather than the precision.
    const decimals = step > 0 ? Math.max(0, Math.ceil(-Math.log10(step / scale))) : 2
    if (decimals > 2) continue
    return `${trimZeros((position / scale).toFixed(decimals))} ${unit}`
  }
  return `${Math.round(position)} bp`
}

/**
 * The gap between two ticks, or `undefined` where there is only one.
 *
 * Measured off the ticks that were produced rather than asked of the ladder a
 * second time: they are what is on screen, and a step recomputed from the domain
 * can disagree with them by a rounding.
 */
function stepOf(ticks: ReadonlyArray<{ bp: number }>): number | undefined {
  return ticks.length < 2 ? undefined : Math.abs(ticks[1].bp - ticks[0].bp)
}

/**
 * `4.60` → `4.6`, `4.00` → `4`, and `4600` → `4600`.
 *
 * The last one is the whole reason this is a function. Stripping trailing zeros
 * with one expression over a string that may have no decimal point at all turns
 * a round number into a tenth of itself, silently, and only at the zooms where
 * the step happens to come out whole.
 */
function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

/**
 * What {@link HeatmapView.setOverlayPainter} is handed on every frame.
 *
 * Exactly the transform state, and nothing about the data: an overlay is placed
 * by the same two `Scale`s the matrix is drawn through, which is what makes it
 * incapable of drifting from the pixels it marks.
 */
export interface OverlayContext {
  plot: Rect
  data: Rect
  rowScale: Scale
  colScale: Scale
  dpr: number
}

export type OverlayPainter = (ctx: CanvasRenderingContext2D, frame: OverlayContext) => void

export interface HeatmapOptions {
  margin?: Partial<Margin>
  /** Contig/genome boundary hairlines. `_SEP_COLOR` in `ops/show.py`. */
  separatorColor?: string
  separatorWidth?: number
  /** Selection-block boundaries. `_GROUP_SEP_COLOR` in `ops/show.py`. */
  groupSeparatorColor?: string
  groupSeparatorWidth?: number
  labelColor?: string
  /** Halo drawn behind labels that fall inside the plot area. */
  labelHaloColor?: string
  labelFont?: string
  /** Draw labels only when an axis has at most this many blocks *in view*. */
  maxLabels?: number
  /**
   * Span, in matrix cells, at or above which a block is labelled however many
   * blocks the axis has.
   *
   * The count rule alone answers "would these names be a smear" with one number
   * for the whole axis, and a real genome is not uniform: 300 contigs, six of
   * them megabases and the rest a few kilobases each. Those six are the ones
   * worth naming and the count rule refuses all 300. Left at `0` — off — where
   * a block is one aggregated unit and its span in cells says nothing about its
   * size in base pairs.
   */
  labelMinSpan?: number
  /** Guide lines for the hovered cell; distinct from every separator colour. */
  crosshairColor?: string
  /** The frame drawn on the plot's own edges, replacing the wrapper's border. */
  plotBorderColor?: string
  /** Rubber-band selection: solid edge, translucent fill. */
  selectionColor?: string
  selectionFill?: string
  /** Below this, a drag is a slip during a click rather than a selection. */
  minSelectPixels?: number
  /** Initial overlay state; each is toggled later by {@link HeatmapView.setPlotOptions}. */
  plotOptions?: Partial<PlotOptions>
  /**
   * Size the label margins from the labels actually drawn, rather than using
   * fixed ones.
   *
   * A fixed margin is wrong in both directions at once: too small and a contig
   * name is clipped (`NODE_7431_len_134871` needs ~150 px, not the 78 px that
   * looked generous while the fixtures had names like `contig_1_035`), too
   * large and every view carries dead space no label ever occupies. Measuring
   * is cheap — it happens once per matrix, not per frame — and it is the only
   * way the same component can serve names of any length.
   */
  autoMargin?: boolean
  /** Override `devicePixelRatio`, mostly for tests. `0` means "detect". */
  devicePixelRatio?: number
  /** Never zoom in past this few cells across the shorter viewport axis. */
  minVisibleCells?: number
  /** Never zoom out past this multiple of the fitted view. */
  maxZoomOut?: number
  /** Fired after any state change that needs a redraw. */
  onChange?: () => void
  /** Fired on a click that was not a drag, for §5.5 cross-navigation. */
  onCellClick?: (cell: Cell) => void
  /**
   * Fired when a modifier-drag selects a box.
   *
   * When set, this *replaces* zoom-to-box as what a selection does: the view
   * that owns the panel opens the region the box covers, which is the thing a
   * box drawn over a contact map is usually asking for. Left unset, the drag
   * zooms, which is what the renderer does on its own.
   */
  onSelect?: (selection: SelectionBox) => void
  /**
   * A selection was made, whatever it then did.
   *
   * Distinct from {@link onSelect}, which *replaces* the zoom: this fires either
   * way, so a listener that only wants to know what was framed — to put it on
   * the clipboard, say — does not have to take over the gesture to hear about
   * it. Fired before the zoom or the emit, so the report is of the box as drawn.
   */
  onSelectionMade?: (selection: SelectionBox) => void
  /**
   * A Shift-drag named a band of one axis.
   *
   * Block-local indices on the named axis, half-open. What the renderer does
   * with the band is {@link HeatmapView.setBandMode}'s business; this is only
   * the report, and it fires in both modes — the owner is the one object that
   * can turn indices into a locus, and both a zoom and a pick want one.
   */
  onBand?: (axis: 'rows' | 'cols', span: [number, number]) => void
  /**
   * What the two spans of a drag say, per axis, already formatted.
   *
   * The renderer owns *where* the numbers go and the caller owns *what they
   * are* (§8.4): a base pair is the block's arithmetic, and this module has no
   * business knowing which contig a cell is in. `null` for an axis with nothing
   * to say — above bin level a cell is a whole sequence, and a coordinate
   * inside one would be an invention.
   */
  selectionLabel?: (selection: SelectionBox) => SelectionText | null
  /**
   * Fired on a click in a label gutter, on the block that label names.
   *
   * A label is the name of a thing the app can open — a genome in the overview,
   * a contig in a genome view — and it is the only part of the picture that
   * says so in words. Clicking it is the obvious gesture, and until it did
   * something it was the one piece of the plot that looked interactive and was
   * not.
   */
  onLabelClick?: (axis: 'rows' | 'cols', block: LabelBlock) => void
  /**
   * Fired as the pointer moves over the plot; `null` when it leaves.
   *
   * `at` is the pointer in canvas CSS pixels, so a tooltip can be positioned
   * without the listener re-deriving coordinates the view has already computed.
   * Absent on the leave event, where there is no position.
   */
  onHover?: (cell: Cell | null, at?: { x: number; y: number }) => void
}

// `plotOptions` is resolved into its own field rather than into `opts`,
// because it is the only option that changes after construction.
/**
 * A drag in progress.
 *
 * `select` is the default and `pan` needs a modifier, which is the way round a
 * *map* wants: zooming into a block is the frequent, precise action, and the
 * one a mouse is bad at doing through a wheel. Panning is the occasional
 * correction afterwards.
 */
interface Drag {
  mode: 'select' | 'pan' | 'band'
  /** Where the button went down, in canvas CSS pixels. */
  x0: number
  y0: number
  /** Where the pointer is now. */
  x: number
  y: number
  /**
   * Whether the box is locked to the diagonal — Shift with the modifier.
   *
   * A cis map is read *along* its diagonal, and the window a reader wants there
   * is almost always symmetric: the same stretch of sequence on both axes. Free
   * hand, that is a square whose corner has to be placed on a line the eye can
   * see and the hand cannot hit, and every miss is a rectangle of two different
   * windows. Locked, the press snaps onto the diagonal and the drag runs along
   * it, so the box is the one thing it was ever going to be.
   */
  diagonal: boolean
}

type ResolvedOptions = Required<
  Omit<
    HeatmapOptions,
    | 'margin'
    | 'onChange'
    | 'onCellClick'
    | 'onLabelClick'
    | 'onSelect'
    | 'onSelectionMade'
    | 'onBand'
    | 'selectionLabel'
    | 'onHover'
    | 'plotOptions'
  >
> & { margin: Margin }

const DEFAULT_MARGIN: Margin = { top: 0, right: 0, bottom: 0, left: 0 }

/**
 * Where a block too short to fill the plot area is put in it.
 *
 * `middle` is the square map's answer and the default: a matrix smaller than
 * the panel is a picture, and a picture is centred. A **turned** band is not
 * that — it is a rectangle whose bottom edge *is* the diagonal, and the tracks
 * under the map are drawn against that same axis. Centred, a band that fits
 * vertically floats half way up its panel with a gap between it and the
 * profiles it is meant to be read against, which is the one arrangement the
 * turn exists to prevent (§17). So a band asks for the edge its diagonal is on:
 * `end` for the ordinary turn, whose separation grows upward, and `start` for
 * the mirrored half of a comparison, where it grows down.
 */
export type VerticalAnchor = 'middle' | 'start' | 'end'

/**
 * Which axes the fitted zoom has to get the whole block onto.
 *
 * `both` is a picture of a matrix: fitting means seeing all of it, so the zoom
 * is whichever of the two axes is tighter. `cols` is a **band** (§17), where the
 * rows are not a thing to fit at all — the block is cut to the height of the box
 * it is drawn in, so "fit the rows" is a tautology at every zoom, and asking for
 * it makes the zoom a function of a number that was derived from the zoom.
 */
export type FitAxis = 'both' | 'cols'

/**
 * The square a drag describes, anchored where it began.
 *
 * A selection *resolves* to a square — the zoom it produced was
 * `min(width/cols, height/rows)`, and the region it now produces is one range
 * applied to both axes — so drawing a rectangle promised something the app was
 * never going to give. The marquee is therefore square as it is drawn, and the
 * side is the longer of the two drags: the shorter one would silently discard
 * ground the pointer had already covered.
 */
function squareFrom(x0: number, y0: number, x: number, y: number): { x: number; y: number; side: number } {
  const side = Math.max(Math.abs(x - x0), Math.abs(y - y0))
  return {
    x: x >= x0 ? x0 : x0 - side,
    y: y >= y0 ? y0 : y0 - side,
    side,
  }
}

/** The rectangle a marquee is drawn as — a square, or a full-height band. */
interface Marquee {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The coordinates written at the edges of a selection being dragged.
 *
 * Here rather than in either surface, because both surfaces draw the same mark
 * for the same gesture: a marquee that zooms to itself is only as good as a
 * reader's ability to put its edges where they mean to, and the shaded box says
 * nothing at all about where they are.
 */
export const SELECTION_FONT = '600 11px system-ui, sans-serif'

/** The size the block labels and the base-pair ticks are written at. */
export const DEFAULT_LABEL_FONT = '10px system-ui, sans-serif'
export const SELECTION_CHIP = 16
export const SELECTION_PAD = 5

/** Air between a chip and the edge it belongs to. */
const SELECTION_GAP = 3

/** Minimum on-screen gap between two drawn labels, in CSS pixels. */
const LABEL_MIN_GAP = 11

/** Breathing room between a label and the plot edge, in CSS pixels. */
const LABEL_GAP = 8

/** How far a boundary tick reaches out of the plot, in CSS pixels. */
const BREAK_LENGTH = 5

/** Minimum on-screen gap between two boundary ticks, in CSS pixels. */
const BREAK_MIN_GAP = 3

/** Gutter left on an edge that carries no labels, in CSS pixels. */
const EDGE_PAD = 6

/** No label gutter may take more than this share of the canvas. */
const MAX_LABEL_FRACTION = 0.34

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

function detectDpr(): number {
  const g = globalThis as { devicePixelRatio?: number }
  return typeof g.devicePixelRatio === 'number' && g.devicePixelRatio > 0
    ? g.devicePixelRatio
    : 1
}

// ---------------------------------------------------------------------------
// HeatmapView
// ---------------------------------------------------------------------------

/**
 * Draws one dense block and owns the pan/zoom transform over it.
 *
 * The view holds two {@link Scale}s, one per axis. It creates them when a
 * matrix is set, but the view state may take ownership with
 * {@link HeatmapView.setScales} — spec §8 requires the heatmap and any bigWig
 * track to share a single scale object rather than each computing its own.
 *
 * Zoom is stored as one scalar (CSS pixels per matrix cell) shared by both
 * axes, so cells stay square exactly as `imshow(aspect="equal")` keeps them.
 * The scales are *written* from that scalar after every change rather than
 * driven independently, which is what makes the invariant unbreakable from
 * outside.
 */
export class HeatmapView {
  private readonly canvas: HTMLCanvasElement
  /**
   * Where the picture goes. Not `readonly`: {@link renderTo} points it at
   * another canvas for the length of one draw, which is what lets an export be
   * the same drawing code at a different resolution rather than a second
   * implementation that can drift from this one.
   */
  private ctx: CanvasRenderingContext2D
  private readonly opts: ResolvedOptions
  private readonly onChange: (() => void) | null
  private readonly onCellClick: ((cell: Cell) => void) | null
  private readonly onLabelClick: ((axis: 'rows' | 'cols', block: LabelBlock) => void) | null
  private readonly onSelect: ((selection: SelectionBox) => void) | null
  private readonly onSelectionMade: ((selection: SelectionBox) => void) | null
  private onBand: ((axis: 'rows' | 'cols', span: [number, number]) => void) | null
  /**
   * What a Shift-drag does when it is let go.
   *
   * `'zoom'` always, except while a form has asked the reader to point at
   * something — see `ui/mapPick.ts`. Held here rather than read from a module
   * so that `render/` stays a renderer: the owner sets it, and the only two
   * things that change with it are whether the release zooms and which cursor
   * the canvas wears while the mode is on.
   */
  private bandMode: 'zoom' | 'pick' = 'zoom'
  /** A band being dragged out on a lane stack; see {@link showBandPreview}. */
  private bandPreview: { axis: 'rows' | 'cols'; from: number; to: number } | null = null
  private readonly selectionLabel: ((selection: SelectionBox) => SelectionText | null) | null
  private readonly onHover: ((cell: Cell | null, at?: { x: number; y: number }) => void) | null

  private matrix: DenseMatrix | null = null
  /** Base-pair mapping per axis; `null` where the axis has no single one. */
  private axisCoords: AxisCoordSet = { rows: null, cols: null }
  private raster: Raster | null = null
  /**
   * The pooled display values behind {@link raster}, kept so that a change of
   * colormap or of clip bounds re-colours them instead of walking the matrix
   * again. Invalidated by a new matrix, a new transform, or balancing.
   */
  private pooled: PooledDisplay | null = null
  /**
   * The block the **auto range** is measured from, when that is not the block on
   * screen; see {@link setMatrix}'s `gauge`.
   */
  private gauge: DenseMatrix | null = null
  /**
   * What measuring it produced, and the colour state it was measured under.
   *
   * The two numbers are kept and the array they came from is not. Pooling the
   * gauge allocates a second raster-sized `Float32Array` — up to the same tens
   * of megabytes the drawn one takes — and every use of it is over the moment
   * the percentile has been read, so holding it would double the panel's
   * steady-state cost to cache a pair of numbers.
   */
  private gaugeRange:
    | { transform: Transform; balanced: boolean; centre: number | null; range: ValueRange }
    | null = null
  private offscreen: RasterCanvas | null = null
  /**
   * Halved copies of {@link offscreen}, coarsest last, built on demand.
   *
   * Dropped whole whenever the raster is rebuilt: a level is a summary of
   * particular pixels, and a stale one would be the previous colormap — or the
   * previous *block* — drawn under this one's ticks. See {@link rasterFor}.
   */
  private mips: RasterCanvas[] = []
  /** Handle of a frame this view scheduled for itself; see {@link changed}. */
  private selfFrame = 0
  /** Cached canvas origin; see {@link clientRect}. `null` means "re-measure". */
  private rectCache: { left: number; top: number } | null = null
  private separators: SeparatorSet = EMPTY_SEPARATORS
  /** {@link blocks}, per axis, until the separators change. */
  private blockCache: { rows: LabelBlock[] | null; cols: LabelBlock[] | null } = {
    rows: null,
    cols: null,
  }
  /**
   * The policy each axis was last measured for, so a view change re-measures
   * the gutters only when the answer has actually changed.
   */
  private labelPolicies: { rows: string; cols: string } = { rows: 'none', cols: 'none' }
  private colorScale: ColorScale
  private dirtyRaster = false
  /**
   * How many times this view has built a raster — see {@link rasterisations}.
   */
  private rasterCount = 0
  /** Whether gestures are held — see {@link setFrozen}. */
  private frozen = false
  /** When the current freeze began, for the spinner's grace period. */
  private frozenAt = 0
  /** The animation loop that turns the spinner; `null` when it is not turning. */
  private spinTimer: number | null = null
  /** What Escape calls, while frozen — see {@link setFrozen}. */
  private onCancelFreeze: (() => void) | null = null
  private plot: PlotOptions
  /**
   * A cell being pointed at on **another** map, for a deck (§16).
   *
   * Drawn as a short cross rather than as two rules across the picture, and the
   * asymmetry is the point: exactly one map has a pointer over it, and five
   * full crosshairs claim five pointers. What the others owe the reader is
   * *where that place is on me* — which a mark the size of a cursor answers,
   * and two lines the width of the panel answer by covering the data being
   * compared.
   */
  private echoCell: { row: number; col: number } | null = null
  /** The cell under the pointer, for the crosshair. `null` when outside. */
  private hoverCell: Cell | null = null
  /**
   * The turn the block on screen was cut with, or `null` for a square map.
   *
   * The one thing this view knows about the rotation, and it is here for the
   * guides alone: everything else about a turned block really is an ordinary
   * dense matrix, which is what `render/rotate.ts` went to the trouble of
   * arranging. The crosshair is the exception because it is not a decoration but
   * a *reading* — it says which cell of the square is under the pointer — and on
   * a turned map that reading runs along two 45° rays rather than along the two
   * axes. See {@link anchorRays}.
   */
  private turn: { maxSeparation: number; direction: RotateDirection } | null = null
  /** What the owner draws on the data; see {@link setOverlayPainter}. */
  private overlayPainter: OverlayPainter | null = null

  private cssWidth = 0
  private cssHeight = 0
  private dpr = 1
  /**
   * Where the plot's own corner sits on the page it is being drawn onto.
   *
   * Zero on screen — the canvas *is* the plot — and set only by
   * {@link renderTo}, where a figure may have to leave room above and to the
   * left of the map for the lane stacks that go there.
   */
  private pageOrigin: { x: number; y: number } = { x: 0, y: 0 }

  /** CSS pixels per matrix cell. */
  private zoom = 1
  /** Zoom at which the whole matrix fits the plot area. */
  private baseZoom = 1
  /** Matrix coordinate at the plot area's left edge. */
  private originX = 0
  /** Matrix coordinate at the plot area's top edge. */
  private originY = 0

  private rowScale = new Scale([0, 1], 1)
  private colScale = new Scale([0, 1], 1)

  /** Where a block shorter than the plot area sits in it; see {@link setAnchor}. */
  private anchorY: VerticalAnchor = 'middle'
  /** Whether a drag names a span of the x axis; see {@link setSpanGestures}. */
  private spanGestures = false
  /** Which axes the fitted zoom has to satisfy; see {@link setFitAxis}. */
  private fitAxis: FitAxis = 'both'

  /**
   * The margin in force. Equals `opts.margin` unless `autoMargin` is set, in
   * which case {@link measureMargin} recomputes it whenever the labels or the
   * canvas size change.
   */
  private computedMargin: Margin

  private detachFns: Array<() => void> = []
  private drag: Drag | null = null
  private dragMoved = false
  /**
   * Where the pointer last was over the canvas, so a modifier pressed without
   * moving it can be answered. `null` once the pointer has left.
   */
  private hoverPoint: { x: number; y: number } | null = null
  private lastX = 0
  private lastY = 0

  constructor(canvas: HTMLCanvasElement, options: HeatmapOptions = {}) {
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('Could not acquire a 2d canvas context')
    this.canvas = canvas
    this.ctx = ctx

    this.opts = {
      margin: { ...DEFAULT_MARGIN, ...(options.margin ?? {}) },
      // #666666 / 0.5pt and #222222 / 1.0pt are _SEP_COLOR, _SEP_WIDTH,
      // _GROUP_SEP_COLOR and _GROUP_SEP_WIDTH in ops/show.py. Kept identical so
      // a browser screenshot and a CLI figure are the same image.
      separatorColor: options.separatorColor ?? '#666666',
      separatorWidth: options.separatorWidth ?? 0.5,
      groupSeparatorColor: options.groupSeparatorColor ?? '#222222',
      groupSeparatorWidth: options.groupSeparatorWidth ?? 1,
      labelColor: options.labelColor ?? '#333333',
      labelHaloColor: options.labelHaloColor ?? 'rgba(255, 255, 255, 0.85)',
      labelFont: options.labelFont ?? DEFAULT_LABEL_FONT,
      maxLabels: options.maxLabels ?? MAX_CATEGORICAL_TICKS,
      labelMinSpan: options.labelMinSpan ?? 0,
      crosshairColor: options.crosshairColor ?? CROSSHAIR_COLOR,
      plotBorderColor: options.plotBorderColor ?? '#b9bec5',
      selectionColor: options.selectionColor ?? '#1f5fa9',
      selectionFill: options.selectionFill ?? 'rgba(31, 95, 169, 0.16)',
      minSelectPixels: options.minSelectPixels ?? 6,
      autoMargin: options.autoMargin ?? false,
      devicePixelRatio: options.devicePixelRatio ?? 0,
      minVisibleCells: options.minVisibleCells ?? 4,
      maxZoomOut: options.maxZoomOut ?? 4,
    }
    this.computedMargin = this.opts.margin
    this.plot = { ...DEFAULT_PLOT_OPTIONS, ...(options.plotOptions ?? {}) }
    this.onChange = options.onChange ?? null
    this.onCellClick = options.onCellClick ?? null
    this.onLabelClick = options.onLabelClick ?? null
    this.onSelect = options.onSelect ?? null
    this.onSelectionMade = options.onSelectionMade ?? null
    this.onBand = options.onBand ?? null
    this.selectionLabel = options.selectionLabel ?? null
    this.onHover = options.onHover ?? null

    // The `metacooler show` defaults, verbatim (spec §7.1). Two NaN bounds mean
    // "vmin 0, vmax at the 99th percentile of the non-zero transformed values",
    // recomputed on every view change until the user clips it by hand.
    this.colorScale = {
      vmin: Number.NaN,
      vmax: Number.NaN,
      transform: 'log1p',
      colormap: 'afmhot_r',
    }
    this.resize()
  }

  // -- geometry ------------------------------------------------------------

  /** The margin actually in force, after any {@link measureMargin} pass. */
  get margin(): Margin {
    return this.computedMargin
  }

  /**
   * Recolour the chrome the *page* owns — labels, their halo, and the plot
   * frame.
   *
   * These are the only colours that have to follow the theme. The separator and
   * crosshair colours deliberately do not: they are `ops/show.py`'s, so a
   * browser screenshot and a CLI figure stay the same image.
   */
  setPalette(palette: {
    labelColor?: string
    labelHaloColor?: string
    plotBorderColor?: string
  }): void {
    if (palette.labelColor !== undefined) this.opts.labelColor = palette.labelColor
    if (palette.labelHaloColor !== undefined) this.opts.labelHaloColor = palette.labelHaloColor
    if (palette.plotBorderColor !== undefined) this.opts.plotBorderColor = palette.plotBorderColor
    this.changed()
  }

  /** The overlay state, as a copy: mutating it must not change the view. */
  get plotOptions(): PlotOptions {
    return { ...this.plot }
  }

  /**
   * Turn overlays on or off.
   *
   * Hiding the labels also gives their gutters back, which is why this remeasures
   * rather than only repainting: the margin exists *for* the labels, and leaving
   * a 150 px band of nothing beside a plot with no names in it would be the dead
   * space {@link measureMargin} was written to remove. A zoom someone chose is
   * kept, so the pixels under the pointer stay under the pointer; a view that
   * was showing the whole block goes on showing the whole block, rather than
   * losing its last few contigs to the gutter that just opened.
   */
  setPlotOptions(next: Partial<PlotOptions>): void {
    const merged = { ...this.plot, ...next }
    const labelsChanged = merged.labels !== this.plot.labels
    this.plot = merged
    if (labelsChanged) this.remeasure()
    // The crosshair is what stands in for the pointer, so turning it off has to
    // give the pointer back without waiting for the hand to move — a control
    // that needs a twitch before it takes effect reads as not having worked.
    this.syncGuidedCursor()
    this.changed()
  }

  /**
   * Size the label gutters to the labels that will actually be drawn.
   *
   * Row labels are horizontal, so they need their text *width* on the left.
   * Column labels are rotated a quarter turn (as matplotlib rotates categorical
   * x ticks), so they need that same text width as *height* on top. Both are
   * capped at {@link MAX_LABEL_FRACTION} of the canvas: a pathological contig
   * name must cost its own legibility, never the plot's.
   *
   * When an axis draws no labels — more blocks than `maxLabels`, or none at all
   * — its gutter collapses to {@link EDGE_PAD}. That is what stops a 4,000-bin
   * genome from reserving 150 px for labels it will not draw, which is the dead
   * space that used to sit under every heatmap.
   */
  measureMargin(): void {
    if (!this.opts.autoMargin) return
    this.labelPolicies = { rows: this.labelPolicy('rows'), cols: this.labelPolicy('cols') }
    const cols = this.marginBlocks('cols')
    const rows = this.marginBlocks('rows')
    this.ctx.save()
    this.ctx.font = this.opts.labelFont
    const widest = (blocks: LabelBlock[]): number => {
      let max = 0
      for (const block of blocks) {
        const w = this.ctx.measureText(block.label).width
        if (w > max) max = w
      }
      return max
    }
    const left = rows.length === 0 ? EDGE_PAD : widest(rows) + LABEL_GAP
    const top = cols.length === 0 ? EDGE_PAD : widest(cols) + LABEL_GAP
    this.ctx.restore()
    this.computedMargin = {
      left: Math.min(left, this.cssWidth * MAX_LABEL_FRACTION),
      top: Math.min(top, this.cssHeight * MAX_LABEL_FRACTION),
      right: EDGE_PAD,
      bottom: EDGE_PAD,
    }
  }

  /** The plot area: the canvas minus the label margins. */
  /** Device pixels per CSS pixel, as this view resolved it. */
  get devicePixelRatio(): number {
    return this.dpr
  }

  /** The block on screen, or `null` before one has been set. */
  get block(): DenseMatrix | null {
    return this.matrix
  }

  get plotRect(): Rect {
    const m = this.computedMargin
    return {
      x: m.left,
      y: m.top,
      width: Math.max(1, this.cssWidth - m.left - m.right),
      height: Math.max(1, this.cssHeight - m.top - m.bottom),
    }
  }

  /**
   * The part of the plot the data actually occupies.
   *
   * Zoomed in it is the plot rect; zoomed out the matrix is smaller than the
   * area reserved for it, and every piece of chrome — the frame, the boxes, the
   * crosshair — has to stop at the data rather than at the panel. A divider
   * running on past the last bin claims there is something out there.
   */
  get dataRect(): Rect {
    const plot = this.plotRect
    const { nrows, ncols } = this.dims()
    const x0 = Math.max(plot.x, plot.x + this.colScale.toPixel(0))
    const x1 = Math.min(plot.x + plot.width, plot.x + this.colScale.toPixel(ncols))
    const y0 = Math.max(plot.y, plot.y + this.rowScale.toPixel(0))
    const y1 = Math.min(plot.y + plot.height, plot.y + this.rowScale.toPixel(nrows))
    return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) }
  }

  /**
   * Re-read the canvas's CSS size and device pixel ratio and resize its backing
   * store. Call on a container resize; it never re-rasterises, because the
   * raster is at *matrix* resolution and is independent of the viewport.
   */
  resize(cssWidth?: number, cssHeight?: number): void {
    this.rectCache = null
    const w = cssWidth ?? this.canvas.clientWidth
    const h = cssHeight ?? this.canvas.clientHeight
    this.cssWidth = w > 0 ? w : this.canvas.width || 1
    this.cssHeight = h > 0 ? h : this.canvas.height || 1
    this.dpr = this.opts.devicePixelRatio > 0 ? this.opts.devicePixelRatio : detectDpr()
    this.canvas.width = Math.max(1, Math.round(this.cssWidth * this.dpr))
    this.canvas.height = Math.max(1, Math.round(this.cssHeight * this.dpr))
    // A view that was showing the whole block goes on showing the whole block.
    // Anything else is measured against the *old* plot area, and re-fitting it
    // would throw away a zoom the user chose; `clampView` keeps that honest.
    //
    // This is also what rescues a panel built before it had a size — the
    // whole-metagenome overview is constructed behind its gate and revealed
    // after the scan, and its zoom, worked out against a one-pixel plot, was
    // then pinned by `clampView` at a quarter of the fit: a 2,048-contig map
    // drawn in the middle of a panel four times its size.
    const wasFitted = this.matrix === null || Math.abs(this.zoom - this.baseZoom) < 1e-9
    // The cap is a fraction of the canvas, so a resize can change the gutters
    // even though the labels have not changed.
    this.measureMargin()
    this.recomputeBaseZoom()
    if (wasFitted) this.zoom = this.baseZoom
    this.clampView()
    this.syncScales()
    this.changed()
  }

  // -- data ----------------------------------------------------------------

  /**
   * Install the block to display and the boundaries to draw over it, then fit
   * it to the viewport.
   *
   * Rasterisation is deferred to the next {@link draw}, so setting a matrix and
   * a colour scale in the same tick costs one pass, not two.
   *
   * @param separators Either a {@link SeparatorSet}, or a single array used for
   * both axes — the symmetric case, which is every view except a genome pair.
   * @param gauge The block the automatic colour range is measured from, when
   * `matrix` is a *crop* of what was read rather than the whole of it — a turned
   * band (§17). Omitted, the range is measured from the block on screen, which
   * is the same thing wherever nothing was cropped. See {@link autoRange}.
   */
  setMatrix(
    matrix: DenseMatrix,
    separators: Separator[] | SeparatorSet = [],
    gauge?: DenseMatrix,
  ): void {
    this.setFrozen(false)
    this.matrix = matrix
    this.separators = Array.isArray(separators)
      ? { rows: separators, cols: separators }
      : separators
    this.blockCache = { rows: null, cols: null }
    // A mapping belongs to one block. Clearing it here means a caller that
    // never calls `setAxisCoords` draws no ticks, rather than drawing the
    // previous block's coordinates over this one's data.
    this.axisCoords = { rows: null, cols: null }
    this.dirtyRaster = true
    this.pooled = null
    this.gauge = gauge ?? null
    this.gaugeRange = null
    this.hoverCell = null
    this.rowScale.setFull([0, Math.max(1, matrix.nrows)])
    this.colScale.setFull([0, Math.max(1, matrix.ncols)])
    // Before `fit`, which divides by the plot area the gutters determine.
    this.measureMargin()
    this.fit()
  }

  /**
   * Swap the values of the block already loaded, keeping the view exactly where
   * it is.
   *
   * {@link setMatrix} ends in `fit`, which is right for a *new* block and wrong
   * for the same block recomputed: a derived value (`render/derive.ts`) is a
   * post-read transform over cells that are already here, so switching one on
   * must not cost a read, must not re-open a gated whole-genome scan, and must
   * not throw away the pan and zoom the reader arrived at — the picture is of
   * the same place, in different units.
   *
   * The dimensions and extents are the caller's to keep identical; nothing here
   * checks, because the only caller is the one that just recomputed this array
   * from the block this object is holding.
   */
  /**
   * Replace the block with one of a **different shape**, keeping the view.
   *
   * Between {@link setMatrix}, which refits, and {@link setValues}, which
   * requires the same shape — and it exists for exactly one caller: a turned
   * band re-cut deeper because the reader zoomed out (§17.2). The picture is of
   * the same place at the same zoom over the same stretch of genome; only the
   * number of rows behind it has changed, and refitting would answer a wheel
   * click by throwing away the window it was made in.
   *
   * The rows need no preserving, which is what makes this safe: a band is cut to
   * fill its box, so where its top edge sits is decided by {@link setAnchor} and
   * `clampView` rather than by anything a caller could carry across. The columns
   * are preserved exactly, because those *are* the reader's window.
   */
  reshape(matrix: DenseMatrix, gauge?: DenseMatrix): void {
    const held = this.originX
    this.matrix = matrix
    this.blockCache = { rows: null, cols: null }
    this.dirtyRaster = true
    this.pooled = null
    this.hoverCell = null
    // The gauge's measurement survives a reshape it was not part of, and that is
    // the difference between a band re-cut in a frame and one re-cut in a
    // second. Measuring it is a pooling *and* a percentile selection over the
    // whole square block — the most expensive thing this class does — and the
    // block a turned map is cut from does not change when the cut does. Dropped
    // unconditionally, every re-cut re-measured a range that could not have
    // moved, which is 80% of the cost of a zoom on a turned map spent proving
    // the colours are the colours they already were.
    if (gauge !== undefined) {
      this.gauge = gauge
      this.gaugeRange = null
    }
    this.rowScale.setFull([0, Math.max(1, matrix.nrows)])
    this.colScale.setFull([0, Math.max(1, matrix.ncols)])
    this.recomputeBaseZoom()
    this.originX = held
    this.clampView()
    this.syncScales()
    this.changed()
  }

  /**
   * Replace the block with one on a **different grid**, and show a named window
   * of it — the swap a zoom-to-refine makes.
   *
   * The third of the three ways a block arrives, and the only one that survives
   * a change of bin size. {@link setMatrix} refits, which throws away the pan and
   * zoom the reader arrived at. {@link reshape} keeps them — but it keeps them as
   * *cell* coordinates, and a cell is a different number of base pairs on every
   * grid, so a block read twice as fine would come back showing half as much
   * genome at twice the magnification. Neither is wrong; both were written for a
   * block whose cells mean what the outgoing block's cells meant.
   *
   * So the window is passed in rather than preserved. The caller holds it in base
   * pairs across the swap and converts it back through the *incoming* block's own
   * axes (`MatrixPanel.regrid`), which is the same conversion the deck's
   * navigation lock does between two panels of different resolution
   * (`panels/lock.ts`) and is the only form that survives a regrid.
   *
   * **The gauge is not touched unless one is given.** That is what stops the
   * colours moving under the reader's hand: the auto range is measured from the
   * widest block held and memoised on it, so refining the picture re-colours
   * nothing and a loop that was bright at fit zoom is the same brightness when
   * the finer data lands. Passing a gauge nulls the memo and re-measures, which
   * is what widening past the block already held has to do.
   *
   * One {@link changed} for the whole operation, so no frame is ever drawn
   * against the incoming block at the outgoing block's zoom.
   */
  regrid(
    matrix: DenseMatrix,
    show: { rows: [number, number]; cols: [number, number] },
    options: {
      separators?: Separator[] | SeparatorSet
      /**
       * `undefined` keeps the gauge in place — the ordinary refine, and what
       * makes it free. A block *replaces* it, which is what widening past what
       * was held has to do. `null` clears it, so the range is measured from the
       * drawn block again.
       */
      gauge?: DenseMatrix | null
    } = {},
  ): void {
    this.matrix = matrix
    if (options.separators !== undefined) {
      this.separators = Array.isArray(options.separators)
        ? { rows: options.separators, cols: options.separators }
        : options.separators
    }
    this.blockCache = { rows: null, cols: null }
    this.dirtyRaster = true
    this.pooled = null
    this.hoverCell = null
    if (options.gauge !== undefined) {
      this.gauge = options.gauge
      this.gaugeRange = null
    }
    this.rowScale.setFull([0, Math.max(1, matrix.nrows)])
    this.colScale.setFull([0, Math.max(1, matrix.ncols)])
    this.recomputeBaseZoom()
    this.placeCellWindow(show.rows, show.cols)
    this.clampView()
    this.syncScales()
    this.changed()
  }

  /**
   * The same grid, new numbers — which means the array must be the same length.
   *
   * One caller can hand over another: a **turned** map, whose band is re-cut
   * behind the picture as the zoom moves and is therefore not always as deep as
   * the box would cut it now. A derivation computed at one depth and swapped
   * into a grid of another is read with the wrong stride — rows of the wrong
   * separation, and a tail of memory nothing wrote under them — and it draws as
   * a solid block of whatever the scale's floor is, which is a very convincing
   * picture of data that does not exist.
   *
   * So a different length is taken at its word rather than trusted: a band's
   * width is a property of the block and only its rows can change, so the row
   * count follows from the length and this is a {@link reshape}. The panel does
   * ask for the right shape (`MatrixPanel.rederive`); this is what makes it not
   * matter if some later caller forgets.
   */
  setValues(values: Float32Array, gauge?: Float32Array): void {
    if (this.matrix === null) return
    const held = this.matrix
    if (values.length !== held.nrows * held.ncols) {
      const nrows = Math.max(1, Math.floor(values.length / Math.max(1, held.ncols)))
      this.reshape({ ...held, nrows, values, rowExtent: [0, nrows] })
      if (gauge !== undefined && this.gauge !== null) {
        this.gauge = { ...this.gauge, values: gauge }
        this.gaugeRange = null
      }
      return
    }
    this.matrix = { ...held, values }
    this.dirtyRaster = true
    // The pooling is a function of the values, so it cannot survive them. The
    // auto range hangs off it and goes with it, which is what re-measures a
    // ratio's scale instead of keeping the counts'.
    this.pooled = null
    // And so does the gauge's, which is the same arithmetic over the block the
    // crop came out of: a derivation recomputed on one and not the other would
    // scale a ratio by the range of the counts it was made from.
    if (this.gauge !== null && gauge !== undefined) this.gauge = { ...this.gauge, values: gauge }
    this.gaugeRange = null
    this.changed()
  }

  /**
   * Declare what each axis measures in base pairs, for the position ticks.
   *
   * Set alongside the matrix and cleared by passing two `null`s. It changes no
   * geometry: the ticks are drawn inside the data, so an axis gaining or losing
   * its coordinates never moves the plot.
   */
  setAxisCoords(coords: AxisCoordSet): void {
    this.axisCoords = coords
    this.changed()
  }

  /**
   * Set the span, in matrix cells, above which a block is labelled whatever the
   * count. `0` turns the rule off.
   *
   * Per matrix, not per view: the caller knows the bin size and whether a cell
   * is a bin at all, and an aggregated cell — one contig, one genome — has a
   * span of exactly one whatever its size, so the rule has nothing to read.
   */
  /**
   * Write the block labels and the axis ticks at a different size.
   *
   * `remeasure` and not a repaint: the gutters this canvas keeps for its labels
   * are *measured* from this font (`measureMargin`), so changing it without
   * re-measuring clips every label above 1.0 and leaves dead space below it.
   */
  setLabelFont(font: string): void {
    if (font === this.opts.labelFont) return
    this.opts.labelFont = font
    this.remeasure()
    this.changed()
  }

  setLabelMinSpan(cells: number): void {
    const next = cells > 0 ? cells : 0
    if (next === this.opts.labelMinSpan) return
    this.opts.labelMinSpan = next
    this.remeasure()
    this.changed()
  }

  /** What each axis measures in base pairs, as a copy. */
  get coordinateAxes(): AxisCoordSet {
    return { ...this.axisCoords }
  }

  /**
   * Set the colour scale. Pass `NaN` for a bound to have {@link autoRangeOf}
   * resolve it — the `metacooler show` default, recomputed on every matrix
   * change, as spec §7.1 requires.
   */
  setScale(scale: ColorScale): void {
    this.colorScale = { ...scale }
    this.dirtyRaster = true
    this.changed()
  }

  /** The scale actually in force, with `vmax` resolved. Drives the colourbar. */
  get effectiveScale(): ColorScale {
    return this.raster?.scale ?? this.colorScale
  }

  /** The block currently displayed. */
  get currentMatrix(): DenseMatrix | null {
    return this.matrix
  }

  /** The row (vertical) axis scale. */
  get scaleY(): Scale {
    return this.rowScale
  }

  /** The column (horizontal) axis scale — the one tracks share (spec §8). */
  get scaleX(): Scale {
    return this.colScale
  }

  /**
   * Hand ownership of the scales to the view state. The heatmap keeps writing
   * its zoom and pan into them, so every track reading the same objects follows
   * the matrix automatically and no second coordinate mapping ever exists.
   */
  setScales(rowScale: Scale, colScale: Scale): void {
    this.rowScale = rowScale
    this.colScale = colScale
    if (this.matrix !== null) {
      this.rowScale.setFull([0, Math.max(1, this.matrix.nrows)])
      this.colScale.setFull([0, Math.max(1, this.matrix.ncols)])
    }
    this.syncScales()
    this.changed()
  }

  // -- view transform ------------------------------------------------------

  /**
   * Where a block shorter than the plot area sits in it — see
   * {@link VerticalAnchor}.
   *
   * Only the vertical, because only the vertical has a case: a block narrower
   * than the plot is narrower on both sides equally, while a turned band has a
   * bottom edge that means something and a top edge that does not.
   *
   * Applied through {@link clampView}, which is the one place the pan is pinned,
   * so every path that could leave slack — a new block, a resize, a zoom out, a
   * gutter opening — lands the same way rather than each remembering to.
   */
  setAnchor(anchor: VerticalAnchor): void {
    if (anchor === this.anchorY) return
    this.anchorY = anchor
    this.clampView()
    this.syncScales()
    this.changed()
  }

  /**
   * Both drags name a **span of the x axis**, not a box — what a turned map
   * needs (§17).
   *
   * Up the side of a turned band is *distance from the diagonal*, which is not a
   * place: a marquee's top and bottom edges name no coordinate, and the row band
   * a mostly-vertical 4C drag would take is a range of separations rather than a
   * stretch of genome. Both gestures were therefore drawing one thing and
   * committing another — the selection came back as a box over row indices the
   * block does not have, and a vertical anchor drag came back as nothing at all,
   * silently, because the axis it asked for is `null`.
   *
   * With this on there is one axis and both gestures use it. A selection is a
   * full-height band over a stretch of the genome and resolves the way an
   * on-diagonal box does — the same window on both axes of the square it was
   * turned out of — and a 4C drag names columns however the hand travelled. That
   * is the "seamless fall-back" the two gestures already had for the square
   * case, applied where the geometry leaves only one honest reading.
   *
   * The diagonal lock goes with it, and for the same reason: on a turned map the
   * diagonal is the bottom edge of the picture, so snapping a corner onto it
   * would be snapping to the frame.
   */
  setSpanGestures(on: boolean): void {
    this.spanGestures = on
  }

  /**
   * Fit the whole matrix into the plot area and centre it — or stand it on the
   * edge {@link setAnchor} named, which is what a turned band asks for.
   */
  fit(): void {
    if (this.frozen) return
    this.recomputeBaseZoom()
    this.zoom = this.baseZoom
    const plot = this.plotRect
    const { nrows, ncols } = this.dims()
    this.originX = (ncols - plot.width / this.zoom) / 2
    this.originY = (nrows - plot.height / this.zoom) / 2
    this.clampView()
    this.syncScales()
    this.changed()
  }

  /** Pan by a screen distance in CSS pixels. Positive `dx` drags content right. */
  panBy(dx: number, dy: number): void {
    if (this.frozen) return
    this.originX -= dx / this.zoom
    this.originY -= dy / this.zoom
    this.clampView()
    this.syncScales()
    this.changed()
  }

  /**
   * Zoom about a point given in canvas CSS pixels, keeping the matrix cell
   * under it fixed. `factor > 1` zooms in.
   */
  zoomAt(x: number, y: number, factor: number): void {
    if (this.frozen) return
    if (!(factor > 0)) throw new RangeError(`Zoom factor must be positive, got ${factor}`)
    const plot = this.plotRect
    const px = x - plot.x
    const py = y - plot.y
    const u = this.originX + px / this.zoom
    const v = this.originY + py / this.zoom
    const next = clamp(this.zoom * factor, this.minZoom(), this.maxZoom())
    this.zoom = next
    this.originX = u - px / next
    this.originY = v - py / next
    this.clampView()
    this.syncScales()
    this.changed()
  }

  /** Current zoom, in CSS pixels per matrix cell. */
  get zoomLevel(): number {
    return this.zoom
  }

  /**
   * Hold the view still, and say so.
   *
   * Set while a finer block is being read for the window on screen
   * (`ui/refine.ts`). Two things happen and both are the point.
   *
   * **The gestures stop.** Pan, zoom and refit are refused for the duration, so
   * the picture is exactly where the reader left it when the new grid arrives
   * and the swap is a change of *sharpness* and nothing else. Letting the zoom
   * run on underneath would mean the block landed against a window that had
   * moved since it was asked for — the reader would see it jump, and the jump
   * would be the app catching up rather than anything in the data.
   *
   * **And it is visible.** The edge of what a block can show is a real boundary
   * and until now it was an invisible one: the picture simply stopped improving,
   * and whether that was the file's limit or the app's was not something the
   * screen said. A held frame with a spinner in the corner says *this is the
   * edge, and going past it costs a read* — at the moment it costs it.
   *
   * The spinner does not appear for {@link SPINNER_DELAY_MS}, because most
   * refines are served out of the chunk cache in a few milliseconds and a
   * spinner that flashes on every wheel notch is worse than none. The freeze
   * itself is immediate either way: a fast read is imperceptible, and a slow one
   * is announced.
   */
  setFrozen(on: boolean, onCancel?: () => void): void {
    if (this.frozen === on) return
    this.frozen = on
    this.onCancelFreeze = on ? (onCancel ?? null) : null
    this.frozenAt = on ? now() : 0
    this.canvas.classList.toggle('is-frozen', on)
    if (on) this.spin()
    else this.stopSpin()
    this.changed()
  }

  /** Whether gestures are currently held. */
  get isFrozen(): boolean {
    return this.frozen
  }

  private spin(): void {
    if (this.spinTimer !== null) return
    const tick = (): void => {
      if (!this.frozen) {
        this.spinTimer = null
        return
      }
      this.spinTimer = frameLoop(tick)
      // A redraw, not a re-raster: `draw` blits the raster it already has, which
      // is what makes a turning spinner cost a `drawImage` rather than a pass
      // over the block (see {@link rasterisations}).
      this.draw()
    }
    this.spinTimer = frameLoop(tick)
  }

  private stopSpin(): void {
    if (this.spinTimer !== null) cancelFrameLoop(this.spinTimer)
    this.spinTimer = null
  }

  /**
   * The spinner, in the bottom-left corner of the plot.
   *
   * Bottom-left because every other corner is taken: the key is top-right, the
   * scale bar and the readout sit along the bottom edge outside the plot, and
   * the top-left is where a turned map's diagonal comes to a point. Inside the
   * plot rather than beside it, because what it is about is the picture.
   */
  private drawSpinner(): void {
    if (!this.frozen) return
    const elapsed = now() - this.frozenAt
    if (elapsed < SPINNER_DELAY_MS) return
    const plot = this.plotRect
    const r = SPINNER_RADIUS
    const cx = plot.x + SPINNER_INSET + r
    const cy = plot.y + plot.height - SPINNER_INSET - r
    const ctx = this.ctx
    ctx.save()
    // A disc behind it, for the same reason the key has one: this is drawn over
    // data, and a ring over a dark map is a ring nobody sees.
    ctx.beginPath()
    ctx.arc(cx, cy, r + 5, 0, Math.PI * 2)
    ctx.fillStyle = this.opts.labelHaloColor
    ctx.globalAlpha = 0.88
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.strokeStyle = this.opts.plotBorderColor
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
    const from = ((elapsed / 900) % 1) * Math.PI * 2
    ctx.strokeStyle = this.opts.labelColor
    ctx.beginPath()
    ctx.arc(cx, cy, r, from, from + Math.PI * 0.7)
    ctx.stroke()
    ctx.restore()
  }

  /**
   * Rasters built since this view was constructed.
   *
   * The module header states that re-rasterising happens on exactly three events
   * — a new matrix, a new colour scale, a new colormap — and never on a pan, a
   * zoom or a resize. Until now that was a claim with nothing behind it: every
   * canvas stub in the suite makes `putImageData` a no-op, so a regression that
   * re-coloured a hundred million cells per wheel notch would have gone green.
   *
   * It is exposed rather than inferred because the alternative is counting
   * `putImageData` calls through a mock, which measures the stub instead of the
   * rule. See `test/unit/raster-count.test.ts`.
   */
  get rasterisations(): number {
    return this.rasterCount
  }

  /**
   * What is on screen, in matrix cells: `[lo, hi)` per axis.
   *
   * The transform stated as a *window* rather than as the origin-and-zoom it is
   * held in, because a window is the only form two panels can exchange. Zoom is
   * CSS pixels per cell, so a panel half as wide showing the same zoom shows
   * half as much genome; and a cell is a different number of base pairs in
   * every file. A window is a claim about the data and survives both (§16.3).
   */
  cellWindow(): { rows: [number, number]; cols: [number, number] } {
    const plot = this.plotRect
    return {
      rows: [this.originY, this.originY + plot.height / this.zoom],
      cols: [this.originX, this.originX + plot.width / this.zoom],
    }
  }

  /**
   * Show a cell window — the inverse of {@link cellWindow}, and what a locked
   * deck drives every panel through.
   *
   * The zoom that fits **the larger** of the two spans, so the whole of what was
   * asked for is on screen even where the panel's aspect differs from the
   * window's. One scalar for both axes is not a limitation to work around here:
   * it is what keeps cells square, exactly as `imshow(aspect="equal")` does, and
   * a lock that broke it would make the two maps disagree about which way is
   * along the genome.
   *
   * `clampView` afterwards, so a panel whose block is shorter than the window
   * stops at its own last row rather than sliding into empty space. The window
   * it then reports is the clamped one, which is the honest answer and is what
   * `ViewportLock` expects to come back.
   */
  showCellWindow(rows: [number, number], cols: [number, number]): void {
    if (this.frozen) return
    this.placeCellWindow(rows, cols)
    this.clampView()
    this.syncScales()
    this.changed()
  }

  /**
   * Show a stretch of the **column** axis, letting the other one follow.
   *
   * {@link zoomToSpan} for a caller that has cells rather than pixels, and the
   * counterpart {@link showCellWindow} cannot be for a band: a turned block's
   * rows are distance from the diagonal, its height in cells is chosen so the cut
   * fills the box at fit zoom, and asking for "these rows and these columns"
   * therefore asks for the zoom that fits the band's whole depth — which is fit
   * zoom, whatever window was named. So the row span is not passed at all here.
   * One scalar still serves both axes, `clampView` stands the band back on its
   * anchor, and what the caller gets is the stretch it asked for at as much
   * magnification as the picture allows.
   */
  showCellSpan(cols: [number, number]): void {
    if (this.frozen) return
    const plot = this.plotRect
    const span = Math.max(1e-6, cols[1] - cols[0])
    const wanted = plot.width / span
    this.zoom = clamp(
      Number.isFinite(wanted) && wanted > 0 ? wanted : this.zoom,
      this.minZoom(),
      this.maxZoom(),
    )
    this.originX = (cols[0] + cols[1]) / 2 - plot.width / this.zoom / 2
    this.clampView()
    this.syncScales()
    this.changed()
  }

  /**
   * The placement half of {@link showCellWindow}, without the clamp, the sync or
   * the notification.
   *
   * Split out for {@link regrid}, which has to reset the block's scales *before*
   * the window is placed and must not announce a half-installed state in
   * between. The two callers therefore share the arithmetic rather than each
   * keeping a copy of "the zoom that fits the larger of two spans", which is the
   * line that keeps cells square and that a second copy would eventually get
   * wrong on one axis only.
   */
  private placeCellWindow(rows: [number, number], cols: [number, number]): void {
    const plot = this.plotRect
    const rowSpan = Math.max(1e-6, rows[1] - rows[0])
    const colSpan = Math.max(1e-6, cols[1] - cols[0])
    const wanted = Math.min(plot.width / colSpan, plot.height / rowSpan)
    this.zoom = clamp(
      Number.isFinite(wanted) && wanted > 0 ? wanted : this.zoom,
      this.minZoom(),
      this.maxZoom(),
    )
    this.originX = (cols[0] + cols[1]) / 2 - plot.width / this.zoom / 2
    this.originY = (rows[0] + rows[1]) / 2 - plot.height / this.zoom / 2
  }

  private dims(): { nrows: number; ncols: number } {
    return this.matrix === null
      ? { nrows: 1, ncols: 1 }
      : { nrows: Math.max(1, this.matrix.nrows), ncols: Math.max(1, this.matrix.ncols) }
  }

  private recomputeBaseZoom(): void {
    const plot = this.plotRect
    const { nrows, ncols } = this.dims()
    const across = plot.width / ncols
    const k = this.fitAxis === 'cols' ? across : Math.min(across, plot.height / nrows)
    this.baseZoom = k > 0 && Number.isFinite(k) ? k : 1
  }

  private minZoom(): number {
    return this.baseZoom / this.opts.maxZoomOut
  }

  private maxZoom(): number {
    const plot = this.plotRect
    // The shorter side, because zooming in past a few cells across the *narrow*
    // axis is where a map stops being a picture. Except on a band, whose narrow
    // axis is the box's height and is not a fact about the data: a band drawn
    // 90 px tall would otherwise cap the zoom at 22 px a cell, which on a
    // 100 kb window is a floor the reader hits immediately.
    const shorter = this.fitAxis === 'cols' ? plot.width : Math.min(plot.width, plot.height)
    return Math.max(this.baseZoom, shorter / this.opts.minVisibleCells)
  }

  /**
   * Which axes a fitted view has to satisfy — see {@link FitAxis}.
   *
   * Re-fits where the view was fitted, exactly as {@link resize} does: the rule
   * for what "the whole block" means has changed, so a picture that was showing
   * the whole block must go on showing it under the new one.
   */
  setFitAxis(axis: FitAxis): void {
    if (axis === this.fitAxis) return
    const wasFitted = this.matrix === null || Math.abs(this.zoom - this.baseZoom) < 1e-9
    this.fitAxis = axis
    this.recomputeBaseZoom()
    if (wasFitted) this.zoom = this.baseZoom
    this.clampView()
    this.syncScales()
    this.changed()
  }

  private clampView(): void {
    this.zoom = clamp(this.zoom, this.minZoom(), this.maxZoom())
    const plot = this.plotRect
    const { nrows, ncols } = this.dims()
    const visW = plot.width / this.zoom
    const visH = plot.height / this.zoom
    // An edge is a wall, not a hint: the data cannot be dragged out of its own
    // frame, so a pan stops when the last row or column reaches the border
    // rather than sliding the map into empty space. When the whole matrix fits,
    // there is nothing to pan and it stays where {@link setAnchor} put it —
    // centred for a square map, on the edge its diagonal is on for a band.
    this.originX = visW >= ncols ? (ncols - visW) / 2 : clamp(this.originX, 0, ncols - visW)
    // A band has no vertical pan at all, however deep it is cut. Up the side is
    // distance from the diagonal, and the diagonal is the floor: a picture whose
    // bottom edge had been dragged off the bottom of the box would be a band
    // that had lost the axis it is measured from. So the anchor decides the row
    // origin outright rather than only when the block happens to fit.
    const pinned = visH >= nrows || this.fitAxis === 'cols'
    this.originY = pinned ? this.restY(nrows, visH) : clamp(this.originY, 0, nrows - visH)
  }

  /**
   * Where the top edge of a block that fits sits, in cells.
   *
   * `end` puts the block's *last* row on the plot's bottom edge, which for a
   * turned band is its diagonal — so the picture stands on the axis its tracks
   * are drawn against, with whatever room is left over above the apex where
   * there is nothing to see anyway.
   */
  private restY(nrows: number, visH: number): number {
    if (this.anchorY === 'start') return 0
    return this.anchorY === 'end' ? nrows - visH : (nrows - visH) / 2
  }

  private syncScales(): void {
    const plot = this.plotRect
    this.colScale.setPixels(plot.width)
    this.rowScale.setPixels(plot.height)
    this.colScale.setDomain([this.originX, this.originX + plot.width / this.zoom])
    this.rowScale.setDomain([this.originY, this.originY + plot.height / this.zoom])
  }

  /**
   * The **single** redraw entry point. Everything that moves the view calls
   * this; nothing calls {@link draw} directly except the export path, which
   * needs a synchronous render into a foreign context.
   *
   * The input handlers used to call `draw()` themselves *and* go through a
   * mutator that ends here, so every pointer event painted twice: once
   * synchronously, at whatever rate the device reports moves, and once from the
   * frame the same call had scheduled. A 120 Hz trackpad drove 180 full repaints
   * a second where 60 would do, and the owner's coalescing guard — the thing
   * that exists to prevent exactly that — was bypassed by the half that did not
   * go through it.
   *
   * With an owner, coalescing is the owner's (`MatrixPanel.schedule`). Without
   * one this schedules its own frame. Where there are no frames at all — Node,
   * and therefore the unit tests — it does nothing, which is exactly what every
   * non-handler mutator here has always done: a caller that wants a picture in
   * that environment asks for one with {@link draw} or {@link rasterize}.
   */
  /**
   * The canvas's position in client coordinates, cached.
   *
   * `getBoundingClientRect` was called once per pointer move and once per touch
   * point — a geometry read on the app's highest-frequency path, which the
   * tooltip's DOM writes in the same handler chain turn into a forced document
   * reflow. The rect changes when the canvas resizes or the page scrolls, and
   * both of those already have a home: {@link resize} clears it, and the scroll
   * listener {@link attach} installs does the same.
   */
  private clientRect(): { left: number; top: number } {
    let rect = this.rectCache
    if (rect === null) {
      const box = this.canvas.getBoundingClientRect()
      rect = { left: box.left, top: box.top }
      this.rectCache = rect
    }
    return rect
  }

  private changed(): void {
    // Before either redraw path: the margin is a function of the view, so it
    // has to be up to date whoever ends up painting.
    this.refreshLabelMargin()
    if (this.onChange !== null) {
      this.onChange()
      return
    }
    if (typeof requestAnimationFrame !== 'function') return
    if (this.selfFrame !== 0) return
    this.selfFrame = requestAnimationFrame(() => {
      this.selfFrame = 0
      this.draw()
    })
  }

  /**
   * Re-measure the gutters when a zoom or a pan has changed what the axes are
   * willing to label.
   *
   * The margin is now a function of the view, because the label policy is: an
   * axis with 20,000 blocks names none of them zoomed out and names them all
   * once fifty are in view. It cannot oscillate. Opening a gutter *shrinks* the
   * plot, so fewer blocks are in view, so the policy that opened it still
   * holds; closing one widens the plot, so more are in view, and it stays
   * closed. Both directions reinforce the decision that caused them.
   *
   * Guarded on the policy rather than on the measurement, so the common frame —
   * a pan that changes nothing about what is labelled — costs two binary
   * searches and no text measurement at all.
   */
  private refreshLabelMargin(): void {
    if (!this.opts.autoMargin || this.matrix === null) return
    const rows = this.labelPolicy('rows')
    const cols = this.labelPolicy('cols')
    if (rows === this.labelPolicies.rows && cols === this.labelPolicies.cols) return
    this.remeasure()
  }

  /**
   * Re-measure the gutters and put the view back in step with the plot area
   * they leave.
   *
   * A view that was showing the whole block goes on showing the whole block —
   * as after a resize, and for the same reason: the gutter is chrome, and
   * losing the last two contigs of a fitted map to it is not something the
   * reader asked for. A zoom someone chose is kept.
   */
  private remeasure(): void {
    const wasFitted = this.matrix === null || Math.abs(this.zoom - this.baseZoom) < 1e-9
    this.measureMargin()
    this.recomputeBaseZoom()
    if (wasFitted) this.zoom = this.baseZoom
    this.clampView()
    this.syncScales()
  }

  /**
   * Zoom to the box the user dragged, in canvas CSS pixels.
   *
   * The two corners arrive in whatever order they were drawn, so both are
   * normalised: a selection made bottom-right to top-left is the same
   * selection. The result is *centred* rather than pinned to the box's corner,
   * because the zoom may be clamped and a clamped box that fills less than the
   * plot should sit in the middle of it.
   */
  zoomToBox(ax: number, ay: number, bx: number, by: number): void {
    const plot = this.plotRect
    const left = Math.max(plot.x, Math.min(ax, bx))
    const right = Math.min(plot.x + plot.width, Math.max(ax, bx))
    const top = Math.max(plot.y, Math.min(ay, by))
    const bottom = Math.min(plot.y + plot.height, Math.max(ay, by))
    const wPx = right - left
    const hPx = bottom - top
    if (wPx < this.opts.minSelectPixels || hPx < this.opts.minSelectPixels) return

    const cols = wPx / this.zoom
    const rows = hPx / this.zoom
    const centreCol = this.originX + (left - plot.x) / this.zoom + cols / 2
    const centreRow = this.originY + (top - plot.y) / this.zoom + rows / 2

    this.zoom = clamp(Math.min(plot.width / cols, plot.height / rows), this.minZoom(), this.maxZoom())
    this.originX = centreCol - plot.width / this.zoom / 2
    this.originY = centreRow - plot.height / this.zoom / 2
    this.clampView()
    this.syncScales()
    this.changed()
  }

  /**
   * What a released Shift-drag does: zoom to the band, and say what it was.
   *
   * A band, not a box — one axis, edge to edge — because the thing a reader is
   * naming is a stretch of *genome*, and on a contact map that stretch is a
   * question about everything it touches. Which axis is decided by which way the
   * hand went, so a drag a few degrees the wrong side of vertical still means
   * what it plainly meant.
   *
   * Reported as **block-local indices on a named axis**, because that is what
   * the owner can turn into a locus: it knows the block's extents and its two
   * coordinate axes, and this does not. The report goes out in both modes and
   * the zoom only in `'zoom'` — a reader pointing at an anchor for a form has
   * not asked for the picture to move, and moving it would take the thing they
   * were pointing at out from under the pointer.
   *
   * A band under one row is still a band: a reader who taps rather than drags
   * has named the bin they tapped, which is the finest locus this resolution can
   * express. The *zoom* declines that one — {@link zoomToBand} has a floor in
   * pixels, so a tap reports a locus and leaves the view alone.
   */
  private finishBand(x0: number, y0: number, x: number, y: number): void {
    const vertical = this.bandIsVertical(x0, y0, x, y)
    const axis = vertical ? 'rows' : 'cols'
    const [a, b] = vertical ? [y0, y] : [x0, x]
    const span = this.bandAt(axis, a, b)
    if (span !== null) this.onBand?.(axis, span)
    if (this.bandMode !== 'zoom') return
    // A turned map has one axis and a band that stands on an edge, so the zoom
    // is the span's — `clampView` puts the band back on its anchor rather than
    // centring it, which {@link zoomToBand} would. Same reading the selection
    // takes there, and for the same reason.
    if (this.spanGestures) this.zoomToSpan(a, b)
    else this.zoomToBand(axis, a, b)
  }

  /**
   * A pixel run along one axis as a half-open **block-local** cell range.
   *
   * Public because the same gesture is made on the lane canvases beside the map
   * (§8.4 glues their pixels to this one's along the shared axis), and one
   * conversion serving both is what keeps a band dragged out beside the map from
   * naming a different stretch than the same band dragged out on it.
   *
   * A run of no width is still one cell — a reader who tapped rather than
   * dragged has named the bin they tapped. `null` only where there is no block.
   */
  bandAt(axis: 'rows' | 'cols', from: number, to: number): [number, number] | null {
    const matrix = this.matrix
    if (matrix === null) return null
    const plot = this.plotRect
    const vertical = axis === 'rows'
    const scale = vertical ? this.rowScale : this.colScale
    const origin = vertical ? plot.y : plot.x
    const a = scale.toUnit(Math.min(from, to) - origin)
    const b = scale.toUnit(Math.max(from, to) - origin)
    const limit = vertical ? matrix.nrows : matrix.ncols
    const lo = Math.max(0, Math.min(limit - 1, Math.floor(a)))
    const hi = Math.max(lo + 1, Math.min(limit, Math.ceil(b)))
    return [lo, hi]
  }

  /**
   * A band being dragged out **on a lane stack**, drawn across the map.
   *
   * The gesture happens beside the picture and the answer is about the picture,
   * so the feedback belongs on the picture: a stack has no marquee of its own,
   * and one added there would say the band stops at the edge of the track. Set
   * per pointer move and cleared on release.
   */
  showBandPreview(axis: 'rows' | 'cols', from: number, to: number): void {
    this.bandPreview = { axis, from, to }
    this.changed()
  }

  clearBandPreview(): void {
    if (this.bandPreview === null) return
    this.bandPreview = null
    this.changed()
  }

  /**
   * Zoom so that a stretch of **one** axis fills the plot along that axis.
   *
   * The other axis keeps its centre and takes the same zoom, because it has no
   * choice: one scalar drives both, which is what keeps a cell square
   * (`imshow(aspect="equal")`). So this is a 1D gesture with a 2D consequence,
   * and stating it that way is the honest description — on a map read about its
   * diagonal the consequence is the square a reader wanted anyway, and off the
   * diagonal it is "this stretch of that sequence, against as much of the other
   * as fits".
   *
   * `from` and `to` are canvas CSS pixels along the named axis, in either order.
   */
  zoomToBand(axis: 'rows' | 'cols', from: number, to: number): void {
    const plot = this.plotRect
    const vertical = axis === 'rows'
    const origin = vertical ? plot.y : plot.x
    const extent = vertical ? plot.height : plot.width
    const other = vertical ? plot.width : plot.height
    const lo = Math.max(origin, Math.min(from, to))
    const hi = Math.min(origin + extent, Math.max(from, to))
    if (hi - lo < this.opts.minSelectPixels) return

    const cells = (hi - lo) / this.zoom
    const near = vertical ? this.originY : this.originX
    const far = vertical ? this.originX : this.originY
    const centre = near + (lo - origin) / this.zoom + cells / 2
    const centreOther = far + other / this.zoom / 2

    this.zoom = clamp(extent / cells, this.minZoom(), this.maxZoom())
    const half = extent / this.zoom / 2
    const halfOther = other / this.zoom / 2
    if (vertical) {
      this.originY = centre - half
      this.originX = centreOther - halfOther
    } else {
      this.originX = centre - half
      this.originY = centreOther - halfOther
    }
    this.clampView()
    this.syncScales()
    this.changed()
  }

  /**
   * Whether a Shift-drag zooms or names a locus for a form that asked.
   *
   * A mode, and treated as one: the canvas wears the selecting cursor for as
   * long as it is on, so the reader can see that the next drag on the picture
   * will do something other than what it usually does.
   */
  setBandMode(mode: 'zoom' | 'pick'): void {
    if (this.bandMode === mode) return
    this.bandMode = mode
    this.canvas.classList.toggle('picking', mode === 'pick')
  }

  /**
   * What a released selection does: hand the box to the owner, or zoom.
   *
   * The box is squared first, so what is acted on is what was drawn. Handing it
   * over rather than zooming is the point — a box over a contact map is nearly
   * always "show me this bit", and zooming answered a question about the
   * picture when the question was about the data. A view that wants the old
   * behaviour simply does not pass `onSelect`.
   */
  private finishSelection(x0: number, y0: number, x: number, y: number): void {
    const found = this.boxFrom(x0, y0, x, y)
    // Before either outcome, and regardless of which: what was framed is the
    // same fact whether the box then zooms or opens a region.
    if (found !== null) this.onSelectionMade?.(found.box)
    const emit = this.onSelect
    if (emit === null) {
      // A band has no top and bottom to zoom to, so the zoom is the span's: the
      // cells stay square, which means the vertical follows the horizontal, and
      // `clampView` then stands the band back on the edge it belongs on.
      if (this.spanGestures) this.zoomToSpan(x0, x)
      else this.zoomToBox(x0, y0, x, y)
      return
    }
    if (found !== null) emit(found.box)
  }

  /**
   * Zoom to a stretch of the x axis, leaving the other one to follow.
   *
   * {@link zoomToBox} for a picture with one axis. The vertical is not ignored
   * so much as *implied*: one zoom scalar serves both, so fitting the span
   * horizontally fixes the vertical too, and where the block is then shorter
   * than the plot {@link clampView} puts it back on its anchor rather than
   * centring it.
   */
  private zoomToSpan(ax: number, bx: number): void {
    const plot = this.plotRect
    const left = Math.max(plot.x, Math.min(ax, bx))
    const right = Math.min(plot.x + plot.width, Math.max(ax, bx))
    const wPx = right - left
    if (wPx < this.opts.minSelectPixels) return
    const cols = wPx / this.zoom
    const centreCol = this.originX + (left - plot.x) / this.zoom + cols / 2
    this.zoom = clamp(plot.width / cols, this.minZoom(), this.maxZoom())
    this.originX = centreCol - plot.width / this.zoom / 2
    this.clampView()
    this.syncScales()
    this.changed()
  }

  /**
   * The cells a drag covers, and the square it is drawn as.
   *
   * One derivation for the two things that must agree about a marquee: what the
   * numbers written on it say, and what is opened when it is let go. They were
   * one function and a promise before; a box whose chips describe a different
   * region from the one that opens is the sort of disagreement nobody notices
   * until they have written it down.
   *
   * `null` for a drag too small to be a selection, or one that misses the data.
   */
  private boxFrom(
    x0: number,
    y0: number,
    x: number,
    y: number,
  ): { box: SelectionBox; rect: Marquee } | null {
    const matrix = this.matrix
    if (matrix === null) return null
    const plot = this.plotRect
    const rect = this.marqueeFrom(x0, y0, x, y)
    if (rect.width < this.opts.minSelectPixels) return null

    // The anchor is where the drag *began*, which is the cell that says what
    // the selection is of. Clamped into the plot first: a drag that started on
    // the frame is still a drag from the nearest cell.
    const anchor = this.cellAt(
      clamp(x0, plot.x, plot.x + plot.width - 1),
      clamp(y0, plot.y, plot.y + plot.height - 1),
    )
    if (anchor === null) return null

    const cols = this.spanOf('cols', rect.x - plot.x, rect.width, matrix.ncols)
    const rows = this.spanOf('rows', rect.y - plot.y, rect.height, matrix.nrows)
    if (cols === null || rows === null) return null
    return { box: { rows, cols, anchor }, rect }
  }

  /**
   * A pixel run along one axis as a half-open cell range, clamped to the block.
   *
   * `null` when the run misses the data entirely, which is what a drag that
   * began inside the plot but outside the matrix produces when the view is
   * zoomed out.
   */
  private spanOf(
    axis: 'rows' | 'cols',
    from: number,
    length: number,
    n: number,
  ): [number, number] | null {
    const scale = axis === 'rows' ? this.rowScale : this.colScale
    const lo = Math.max(0, Math.floor(scale.toUnit(from)))
    const hi = Math.min(n, Math.ceil(scale.toUnit(from + length)))
    return hi > lo ? [lo, hi] : null
  }

  /**
   * The point on the map's diagonal nearest a pointer, in canvas pixels.
   *
   * The diagonal is where the two axes name the *same* bin, which is not the
   * geometric 45° line through the corner unless the two blocks start together:
   * on a chrII×chrI panel the row at matrix index 0 is a different bin from the
   * column at matrix index 0, and the locus a reader means by "the diagonal" is
   * offset by the difference. `offset` is that difference, so the line this
   * projects onto is `col = row + offset` and an off-diagonal panel — where the
   * diagonal is nowhere on screen — falls out as an interval with nothing in it.
   *
   * The projection is the perpendicular foot in *matrix* coordinates, which is
   * the honest reading of "the nearest coordinate along the diagonal", and then
   * the result is walked back along the line until both pixel coordinates are
   * inside the plot. Clamping the pixels instead would be the obvious thing and
   * the wrong one: an x pulled to the edge on its own is a point off the line,
   * which is exactly what this exists to prevent.
   */
  private onDiagonal(x: number, y: number): [number, number] {
    const matrix = this.matrix
    if (matrix === null) return [x, y]
    const plot = this.plotRect
    const offset = matrix.rowExtent[0] - matrix.colExtent[0]
    const col = this.colScale.toUnit(x - plot.x)
    const row = this.rowScale.toUnit(y - plot.y)
    // Perpendicular foot on `col = row + offset`, parametrised by the row.
    let r = (row + col - offset) / 2

    // The stretch of the line the plot can show, as an interval in `r`. Empty
    // when the diagonal misses this panel altogether, and then left alone: a
    // snapped point nobody can see beats a point that is not on the diagonal.
    const lo = Math.max(this.rowScale.toUnit(0), this.colScale.toUnit(0) - offset)
    const hi = Math.min(
      this.rowScale.toUnit(plot.height),
      this.colScale.toUnit(plot.width) - offset,
    )
    if (hi > lo) r = clamp(r, lo, hi)

    return [plot.x + this.colScale.toPixel(r + offset), plot.y + this.rowScale.toPixel(r)]
  }

  // -- hit testing ---------------------------------------------------------

  /**
   * The cell under a point given in canvas CSS pixels, or `null` outside the
   * matrix. This is the entry point for clicking an off-diagonal cell to open
   * the corresponding genome pair (spec §5.5).
   */
  cellAt(x: number, y: number): Cell | null {
    const matrix = this.matrix
    if (matrix === null) return null
    const plot = this.plotRect
    if (x < plot.x || y < plot.y || x >= plot.x + plot.width || y >= plot.y + plot.height) {
      return null
    }
    const col = this.colScale.cellAt(x - plot.x)
    const row = this.rowScale.cellAt(y - plot.y)
    if (col < 0 || row < 0 || row >= matrix.nrows || col >= matrix.ncols) return null
    return {
      row,
      col,
      rowBin: matrix.rowExtent[0] + row,
      colBin: matrix.colExtent[0] + col,
      value: matrix.values[row * matrix.ncols + col],
    }
  }

  /**
   * The labelled block under a point in a gutter, or `null`.
   *
   * The target is the whole band above (or beside) the block, not the drawn
   * glyphs: a rotated 10 px name is a two-pixel-wide thing to ask anyone to
   * hit, and the band is unambiguous — one block owns each column of the top
   * gutter. Crowded labels are elided at {@link LABEL_MIN_GAP}, so a band may
   * have no name written over it; it still belongs to its block, and clicking
   * it opens what a wider window would have named.
   */
  labelAt(x: number, y: number): { axis: 'rows' | 'cols'; block: LabelBlock } | null {
    const plot = this.plotRect
    const inRows = x < plot.x && y >= plot.y && y < plot.y + plot.height
    const inCols = y < plot.y && x >= plot.x && x < plot.x + plot.width
    if (!inRows && !inCols) return null
    const axis = inRows ? 'rows' : 'cols'
    const scale = inRows ? this.rowScale : this.colScale
    const unit = scale.cellAt(inRows ? y - plot.y : x - plot.x)
    if (unit < 0) return null
    const block = this.labelBlocks(axis).find((b) => unit >= b.start && unit < b.end)
    return block === undefined ? null : { axis, block }
  }

  /**
   * What a click or tap at this point would open, or `null` for nothing.
   *
   * One answer for the mouse and the finger, so a phone cannot end up with a
   * different idea of what is clickable than a laptop.
   */
  private hitAction(x: number, y: number): (() => void) | null {
    const cell = this.cellAt(x, y)
    if (cell !== null) {
      const emit = this.onCellClick
      return emit === null ? null : () => emit(cell)
    }
    const emit = this.onLabelClick
    if (emit === null) return null
    const hit = this.labelAt(x, y)
    return hit === null ? null : () => emit(hit.axis, hit.block)
  }

  // -- drawing -------------------------------------------------------------

  /** Rasterise if needed, then paint. Cheap enough to call every frame. */
  draw(): void {
    const ctx = this.ctx
    // Every transform below carries the page origin, which is zero on screen and
    // is the room a figure's top and left lane stacks need. `clearRect` under it
    // clears the plot's own box rather than the whole page, which is what lets
    // the lanes be drawn before or after the map without one wiping the other.
    const originX = this.pageOrigin.x * this.dpr
    const originY = this.pageOrigin.y * this.dpr
    ctx.setTransform(this.dpr, 0, 0, this.dpr, originX, originY)
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight)
    if (this.matrix === null) return

    if (this.dirtyRaster || this.raster === null) this.rasterizeNow()
    const offscreen = this.offscreen
    if (offscreen === null) return

    const plot = this.plotRect
    ctx.save()
    ctx.beginPath()
    ctx.rect(plot.x, plot.y, plot.width, plot.height)
    ctx.clip()

    // Nearest-neighbour while magnifying, which is what matplotlib's
    // `interpolation="none"` gives at the DPI `show` renders at, and which keeps
    // single-bin features crisp. While minifying, let the browser filter: point
    // sampling drops most of a sparse contact map's non-zero cells, and a dimmed
    // pixel is a far better lie than a missing one.
    //
    // `stride` is what a pooled raster costs the transform: one raster pixel
    // covers that many matrix cells per axis, so the image is drawn that much
    // larger. Everything else — hit testing, separators, labels — stays in
    // matrix space and is unaffected.
    const sx = this.raster?.strideX ?? 1
    const sy = this.raster?.strideY ?? 1
    // Measured in the pixels the image is actually resampled into, which are
    // device pixels: the transform below carries `dpr` and this test did not, so
    // on a 2× display everything between one and two raster pixels per device
    // pixel was *magnified* through a bilinear filter — the one combination that
    // has nothing to recommend it, since filtering exists to keep minification
    // from dropping cells and there is nothing to drop while enlarging. It also
    // matters on export, where `dpr` becomes the DPI scale (`renderTo`) and a
    // 300 dpi figure was being smoothed as though it were a screen.
    ctx.imageSmoothingEnabled = this.zoom * Math.min(sx, sy) * this.dpr < 1

    // …and *what* it filters, which is the other half of that sentence and was
    // missing. A canvas filter is one bilinear tap: it reads a 2 × 2
    // neighbourhood per destination pixel, which is right down to a halving and
    // a fiction beyond it. A whole chromosome at 1 kb is a 3,000-pixel raster in
    // 460, so seven cells out of eight were never read — and on a turned map,
    // whose lattice is half a bin and shifts parity row by row
    // (`render/rotate.ts`), what beats against the pixel grid is a moiré of
    // diagonal stripes across the band. The pyramid is what makes the filter
    // true: every level is a real average of the one above it, so the level this
    // picks is at most a halving away from the pixels it is drawn into.
    const source = this.rasterFor(this.zoom * Math.max(sx, sy) * this.dpr) ?? offscreen

    ctx.setTransform(
      this.zoom * sx * this.dpr,
      0,
      0,
      this.zoom * sy * this.dpr,
      originX + this.dpr * (plot.x - this.originX * this.zoom),
      originY + this.dpr * (plot.y - this.originY * this.zoom)
    )
    // Onto the footprint the *full* raster covers, whichever level is being
    // sampled: the transform is the matrix's, so a level has to be stretched
    // back over the block it summarises or the picture would shrink by the
    // rounding of its own last row. That keeps every level registered to the
    // same pixels as level 0, which is what the ticks, the separators and the
    // overlays are placed against.
    ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, offscreen.width, offscreen.height)
    ctx.restore()

    ctx.setTransform(this.dpr, 0, 0, this.dpr, originX, originY)
    if (this.plot.dividers) this.drawSeparators()
    if (this.plot.breaks) this.drawBreaks()
    this.drawLabels()
    this.drawOverlay()
    if (this.plot.ticks) this.drawTicks()
    if (this.plot.crosshair) {
      this.drawCrosshair()
      this.drawEcho()
    }
    this.drawSelection()
    this.drawPlotBorder()
    // Last, so it is over everything including the border: it is not part of the
    // picture, it is a statement about the picture's state.
    this.drawSpinner()
  }

  /**
   * Which copy of the raster to sample, for a draw that shrinks it by `scale`.
   *
   * `scale` is destination pixels per raster pixel on the axis that is shrunk
   * *least* — the level halves both axes at once, so taking the other one would
   * blur the sharper axis to suit the softer one. One or more is a magnification
   * and answers with the raster itself; below that it answers with the level
   * whose own pixels land between a half and one destination pixel, which is
   * where a bilinear tap is a filter rather than a sample.
   *
   * **Built here rather than in {@link rasterizeNow}**, because most pictures
   * never need a level: a region view is drawn a pixel or more per bin and every
   * level built for it would be a canvas allocated, filled and never read. Each
   * one costs a quarter of the one above it and they are dropped whole whenever
   * the raster is rebuilt, so a colormap change pays for at most what the next
   * frame actually asks for.
   */
  private rasterFor(scale: number): RasterCanvas | null {
    const base = this.offscreen
    if (base === null || !(scale > 0) || scale >= 1) return base
    const wanted = Math.min(MAX_RASTER_LEVELS, Math.floor(Math.log2(1 / scale)))
    while (this.mips.length < wanted) {
      const from = this.mips[this.mips.length - 1] ?? base
      // A level small enough that halving it again would be averaging away the
      // picture rather than the noise in it. The cap above says the same thing
      // for a raster that starts small.
      if (from.width <= MIN_RASTER_LEVEL || from.height <= MIN_RASTER_LEVEL) break
      const next = halveRaster(from)
      if (next === null) break
      this.mips.push(next)
    }
    return this.mips[Math.min(wanted, this.mips.length) - 1] ?? base
  }

  /**
   * Whatever the owner draws on the data — loops, domains, hand-drawn marks.
   *
   * A callback rather than a list of shapes, because the renderer has no
   * business knowing what a loop is: what it owns is the transform, and the one
   * thing it can offer that nobody else can is the guarantee that the shapes are
   * drawn in it. Clipped to the *data* rather than to the plot, so a circle at
   * the last bin cannot spill onto the frame.
   *
   * Painted after the dividers and labels and before the ticks and crosshair:
   * over the picture, under the instruments.
   */
  private drawOverlay(): void {
    const paint = this.overlayPainter
    const data = this.dataRect
    if (paint === null || data.width <= 0 || data.height <= 0) return
    const ctx = this.ctx
    ctx.save()
    ctx.beginPath()
    ctx.rect(data.x, data.y, data.width, data.height)
    ctx.clip()
    paint(ctx, {
      plot: this.plotRect,
      data,
      rowScale: this.rowScale,
      colScale: this.colScale,
      dpr: this.dpr,
    })
    ctx.restore()
  }

  /** Install (or clear) the overlay painter. */
  setOverlayPainter(paint: OverlayPainter | null): void {
    this.overlayPainter = paint
    this.changed()
  }

  /**
   * Draw the current view into another context at `scale` device pixels per CSS
   * pixel — the export path.
   *
   * The layout does not move: the same margins, the same zoom, the same pan,
   * the same visible range. Only the density changes, so a 300 dpi PNG has
   * sharper labels and hairlines rather than a wider picture. The raster itself
   * is at matrix resolution and independent of this, so nothing is
   * re-rasterised either.
   *
   * `origin` is where the plot's own top-left corner goes on the page, in CSS
   * pixels. Zero on screen, and on a figure whatever the lane stacks *before*
   * the map need: a strip above it or down its left side is part of the picture
   * and has to be drawn somewhere, and everything else on the page is placed
   * against this corner rather than against the canvas's.
   */
  renderTo(
    ctx: CanvasRenderingContext2D,
    scale: number,
    origin: { x: number; y: number } = { x: 0, y: 0 },
  ): void {
    const previousCtx = this.ctx
    const previousDpr = this.dpr
    const previousOrigin = this.pageOrigin
    this.ctx = ctx
    this.dpr = scale
    this.pageOrigin = origin
    try {
      this.draw()
    } finally {
      this.ctx = previousCtx
      this.dpr = previousDpr
      this.pageOrigin = previousOrigin
    }
  }

  /** The canvas size the export needs, in CSS pixels. */
  get cssSize(): { width: number; height: number } {
    return { width: this.cssWidth, height: this.cssHeight }
  }

  /**
   * The base pairs an axis actually shows, or `null` where it has no single
   * coordinate system to show them in.
   *
   * Bin-aligned, because the cells are: the window reported is the one drawn,
   * not the fractional domain the transform happens to hold. `whole` says the
   * picture is the entire sequence from its first base — which is the only case
   * where naming the range adds nothing, since the name already implies it.
   */
  framedRange(axis: 'rows' | 'cols'): { start: number; end: number; whole: boolean } | null {
    const coords = axis === 'rows' ? this.axisCoords.rows : this.axisCoords.cols
    if (coords === null) return null
    const scale = axis === 'rows' ? this.rowScale : this.colScale
    const n = axis === 'rows' ? this.dims().nrows : this.dims().ncols
    const [d0, d1] = scale.domain
    const lo = Math.max(0, Math.floor(d0))
    const hi = Math.min(n, Math.ceil(d1))
    if (!(hi > lo)) return null
    return {
      start: coords.bpAtOrigin + lo * coords.bpPerCell,
      end: coords.bpAtOrigin + hi * coords.bpPerCell,
      whole: coords.bpAtOrigin === 0 && lo === 0 && hi === n,
    }
  }

  /**
   * The frame, drawn on the plot's own edges.
   *
   * It belongs to the canvas rather than to the wrapping element: the plot is
   * inset by however much the labels need, so a border on the wrapper sits some
   * arbitrary distance away from the data with dead space between. Drawn last,
   * so nothing overlaps it.
   */
  private drawPlotBorder(): void {
    const data = this.dataRect
    if (data.width <= 0 || data.height <= 0) return
    const ctx = this.ctx
    ctx.save()
    ctx.strokeStyle = this.opts.plotBorderColor
    ctx.lineWidth = Math.max(1 / this.dpr, 0.75)
    ctx.strokeRect(
      this.snap(data.x),
      this.snap(data.y),
      Math.round(data.width),
      Math.round(data.height)
    )
    ctx.restore()
  }

  /**
   * The band a Shift-drag is covering: one axis, edge to edge.
   *
   * A stripe rather than a box, because that is what the gesture names — a
   * stretch of one axis, and everything it meets. Drawing it as a square would
   * be drawing the wrong claim: it would say the far axis is bounded by the
   * drag, and it is not.
   */
  /**
   * Which axis a band drag names — rows across, or columns down the picture.
   *
   * The band follows the hand: a mostly-vertical drag names rows, a
   * mostly-horizontal one names columns. Both the paint and the commit ask this,
   * so what is drawn is what is taken. Under {@link setSpanGestures} the hand is
   * not consulted — a turned map has one axis a band can be about.
   */
  private bandIsVertical(x0: number, y0: number, x: number, y: number): boolean {
    if (this.spanGestures) return false
    return Math.abs(y - y0) >= Math.abs(x - x0)
  }

  private drawBand(): void {
    const drag = this.drag
    const preview = this.bandPreview
    // Which axis, and between which two pixels. A drag is asked of the hand
    // through {@link bandIsVertical}, so what is drawn is what {@link finishBand}
    // will take; a preview from a lane stack has already been told its axis.
    let vertical: boolean
    let a: number
    let b: number
    if (drag !== null && drag.mode === 'band') {
      vertical = this.bandIsVertical(drag.x0, drag.y0, drag.x, drag.y)
      ;[a, b] = vertical ? [drag.y0, drag.y] : [drag.x0, drag.x]
    } else if (preview !== null) {
      vertical = preview.axis === 'rows'
      ;[a, b] = [preview.from, preview.to]
    } else {
      return
    }
    const plot = this.dataRect
    const from = Math.min(a, b)
    const size = Math.max(1, Math.abs(b - a))
    const ctx = this.ctx
    ctx.save()
    ctx.beginPath()
    ctx.rect(plot.x, plot.y, plot.width, plot.height)
    ctx.clip()
    ctx.fillStyle = this.opts.selectionFill
    if (vertical) ctx.fillRect(plot.x, from, plot.width, size)
    else ctx.fillRect(from, plot.y, size, plot.height)
    ctx.strokeStyle = this.opts.selectionColor
    ctx.lineWidth = Math.max(1 / this.dpr, 1)
    // The two long edges only: the ends are the edges of the plot, and a rule
    // drawn there would look like a boundary the reader had chosen.
    ctx.beginPath()
    for (const edge of [from, from + size]) {
      if (vertical) {
        ctx.moveTo(plot.x, this.snap(edge))
        ctx.lineTo(plot.x + plot.width, this.snap(edge))
      } else {
        ctx.moveTo(this.snap(edge), plot.y)
        ctx.lineTo(this.snap(edge), plot.y + plot.height)
      }
    }
    ctx.stroke()
    ctx.restore()
  }

  /**
   * The rectangle a selection drag is drawn as.
   *
   * A square by default, anchored where the drag began — see {@link squareFrom}
   * for why a selection that *resolves* to one range must not be drawn as a
   * rectangle. Under {@link setSpanGestures} it is a band the full height of the
   * plot instead, because that is what the gesture now commits: a stretch of the
   * genome, opened on both axes. A square there would draw a top and a bottom
   * edge over an axis that has no coordinates to bound.
   */
  private marqueeFrom(x0: number, y0: number, x: number, y: number): Marquee {
    if (!this.spanGestures) {
      const square = squareFrom(x0, y0, x, y)
      return { x: square.x, y: square.y, width: square.side, height: square.side }
    }
    const plot = this.plotRect
    return {
      x: Math.min(x0, x),
      y: plot.y,
      width: Math.abs(x - x0),
      height: plot.height,
    }
  }

  /** The rubber band, while a selection drag is in progress. */
  private drawSelection(): void {
    const drag = this.drag
    if (drag?.mode === 'band' || this.bandPreview !== null) {
      this.drawBand()
      return
    }
    if (drag === null || drag.mode !== 'select' || !this.dragMoved) return
    const plot = this.dataRect
    const ctx = this.ctx
    const { x, y, width: w, height: h } = this.marqueeFrom(drag.x0, drag.y0, drag.x, drag.y)
    ctx.save()
    ctx.beginPath()
    ctx.rect(plot.x, plot.y, plot.width, plot.height)
    ctx.clip()
    ctx.fillStyle = this.opts.selectionFill
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = this.opts.selectionColor
    ctx.lineWidth = Math.max(1 / this.dpr, 1)
    ctx.strokeRect(this.snap(x), this.snap(y), Math.round(w), Math.round(h))
    ctx.restore()

    // After the clip is released, and that is not tidiness: a box dragged to the
    // edge of the data is exactly the box whose numbers a reader most wants, and
    // chips drawn inside the clip are the ones that would be taken away.
    const label = this.selectionLabel
    if (label === null) return
    const found = this.boxFrom(drag.x0, drag.y0, drag.x, drag.y)
    if (found === null) return
    const text = label(found.box)
    if (text !== null) this.drawSelectionMarks(found.rect, text)
  }

  /**
   * The coordinates at the edges of the box being dragged.
   *
   * Both ends of both axes, written *outside* their own edge so the numbers
   * never sit on the region they are measuring, and folded back inside at the
   * canvas edges — a coordinate written off the side of the canvas is a
   * coordinate nobody can read, and the edges are exactly where a selection is
   * dragged to. The width goes in the middle of each side, where the eye
   * already is, and is dropped when the box is too small to hold it.
   *
   * Both axes and not one, even though the marquee is square: a square in
   * pixels is two different spans in base pairs the moment the axes are two
   * different sequences, and against a short contig's clamped end they differ
   * again.
   */
  private drawSelectionMarks(rect: Marquee, text: SelectionText): void {
    const ctx = this.ctx
    const left = rect.x
    const right = rect.x + rect.width
    const top = rect.y
    const bottom = rect.y + rect.height
    ctx.save()
    ctx.font = SELECTION_FONT
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    const widthOf = (label: string): number => ctx.measureText(label).width + SELECTION_PAD * 2
    /**
     * A chip at `x, y`, folded back inside the canvas at its edges.
     *
     * A coordinate written off the side of the canvas is a coordinate nobody
     * can read, and the edges are exactly where a selection gets dragged to.
     */
    const chip = (label: string, x: number, y: number): void => {
      if (label === '') return
      const width = widthOf(label)
      const at = clamp(x, 0, Math.max(0, this.cssWidth - width))
      const row = clamp(y, 0, Math.max(0, this.cssHeight - SELECTION_CHIP))
      ctx.fillStyle = this.opts.labelHaloColor
      ctx.strokeStyle = this.opts.crosshairColor
      ctx.lineWidth = 1
      ctx.beginPath()
      if (ctx.roundRect === undefined) ctx.rect(at, row, width, SELECTION_CHIP)
      else ctx.roundRect(at, row, width, SELECTION_CHIP, 3)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = this.opts.crosshairColor
      ctx.fillText(label, at + SELECTION_PAD, row + SELECTION_CHIP / 2)
    }

    // Each end written *outside* its own edge, which is the 1D browser's rule
    // and the only placement that cannot self-overlap: a small box is exactly
    // the case where two chips inside one would be drawn on top of each other,
    // and it is also the case where the numbers matter most.
    const cols = text.cols
    if (cols !== null) {
      const above = top - SELECTION_CHIP - SELECTION_GAP
      const row = above >= 0 ? above : bottom + SELECTION_GAP
      chip(cols.start, left - widthOf(cols.start) - SELECTION_GAP, row)
      chip(cols.end, right + SELECTION_GAP, row)
      // The width in the middle of what has been drawn, where the eye already
      // is — and only where the box is wide enough to hold it, since a chip
      // wider than the region it measures is a chip over the data.
      const span = widthOf(cols.span)
      if (rect.width > span + 8) {
        const second = above >= 0 ? row - SELECTION_CHIP - SELECTION_GAP : row + SELECTION_CHIP + SELECTION_GAP
        chip(cols.span, (left + right) / 2 - span / 2, second)
      }
    }

    // On the diagonal the square covers the same window on both axes, and
    // writing it twice says the picture is of two things when it is of one.
    // Compared as *written*, not as computed: the marquee is square in pixels
    // and the two axes sit at two different margins, so a cis box routinely
    // rounds to ends one cell apart — a difference the line cannot show and the
    // reader cannot act on. Two chips that would read the same are one chip.
    const same =
      cols !== null &&
      text.rows !== null &&
      text.rows.start === cols.start &&
      text.rows.span === cols.span
    const rows = same ? null : text.rows
    if (rows !== null) {
      const widest = Math.max(widthOf(rows.start), widthOf(rows.end), widthOf(rows.span))
      const beside = left - widest - SELECTION_GAP
      const column = beside >= 0 ? beside : right + SELECTION_GAP
      // Level with the edge each names rather than outside it: the column is
      // already clear of the data horizontally, and a chip *above* the top edge
      // would land on the row the other axis is using.
      chip(rows.start, column, top)
      chip(rows.end, column, bottom - SELECTION_CHIP)
      if (rect.height > SELECTION_CHIP * 2 + 8) {
        chip(rows.span, column, (top + bottom) / 2 - SELECTION_CHIP / 2)
      }
    }
    ctx.restore()
  }

  /**
   * The colour scale with any automatic bound filled in.
   *
   * Resolved here rather than left to {@link colorize} for one reason: the block
   * the range is measured from is not always the block being coloured. Where
   * there is no {@link gauge} this is exactly what `colorize` would have worked
   * out for itself, over the same memoised value.
   */
  private resolvedScale(centre: number | null): ColorScale {
    const scale = this.colorScale
    if (Number.isFinite(scale.vmin) && Number.isFinite(scale.vmax)) return scale
    const auto = this.autoRange(centre)
    return {
      ...scale,
      vmin: Number.isFinite(scale.vmin) ? scale.vmin : auto.vmin,
      vmax: Number.isFinite(scale.vmax) ? scale.vmax : auto.vmax,
    }
  }

  /**
   * The automatic bounds: a property of **the block that was read**, not of the
   * part of it on screen.
   *
   * That is already the rule for a square map — the range is measured once per
   * read and a pan or a zoom does not move it — and the {@link gauge} is what
   * extends it to a turned one. A band is a *crop* of the block: it holds the
   * near-diagonal separations and drops the rest, and on a diverging field the
   * dropped ones are exactly where the extremes are, so measuring the band
   * halved the range the moment the map was turned and moved it again on every
   * drag of the depth handle. A turn is a change of geometry; it must not
   * recolour the picture.
   *
   * The square map's own rule is `metacooler show`'s, to the bit (§7.1), so the
   * two can only be made to agree in this direction: the band adopts the block's
   * range, never the other way round.
   */
  private autoRange(centre: number | null): ValueRange {
    const pooled = this.pooled
    const gauge = this.gauge
    if (pooled === null) return { vmin: 0, vmax: 1 }
    if (gauge === null) return autoRangeOfPooled(pooled)
    const held = this.gaugeRange
    if (
      held === null ||
      held.transform !== pooled.transform ||
      held.balanced !== pooled.balanced ||
      held.centre !== centre
    ) {
      // Pooled the same way the drawn block is, because the range has to be the
      // one the square view would show and that one is measured over a *pooled*
      // raster — above the cap a pooled cell is the brightest of the several it
      // stands for, which moves a percentile.
      const measured = poolDisplay(gauge, this.colorScale)
      this.gaugeRange = {
        transform: pooled.transform,
        balanced: pooled.balanced,
        centre,
        range: autoRangeOfPooled(measured),
      }
    }
    return (this.gaugeRange as { range: ValueRange }).range
  }

  private rasterizeNow(): void {
    if (this.matrix === null) return
    this.rasterCount += 1
    const balanced = this.colorScale.balanced === true
    // `centre` is in the key for the same reason the other two are: it selects
    // the reduction, so a pooling made for counts is the wrong array for a ratio
    // even at an identical transform. Compared in display units, which is what
    // the pooled block stores, so switching derivation *and* transform together
    // is still one comparison.
    const centre =
      this.colorScale.neutral === undefined
        ? null
        : transformValue(this.colorScale.neutral, this.colorScale.transform)
    // A turned band's two axes are one measure, so its raster pixels have to be
    // square in matrix space ({@link Raster.strideX}). In the key for the same
    // reason as the three above it: it selects the reduction, so a pooling made
    // for the square is the wrong array for the band — and pressing the turn
    // toggle changes nothing else about the numbers.
    const isotropic = this.turn !== null
    if (
      this.pooled === null ||
      this.pooled.transform !== this.colorScale.transform ||
      this.pooled.balanced !== balanced ||
      this.pooled.centre !== centre ||
      this.pooled.isotropic !== isotropic
    ) {
      this.pooled = poolDisplay(this.matrix, this.colorScale, { isotropic })
    }
    // Both buffers are handed back to the next colouring. A colormap change or
    // a clip drag never resizes the raster, so the common case reuses a 4 B/px
    // `Uint8ClampedArray` and a canvas of the same size instead of allocating
    // and orphaning both — ~131 MB of churn per click on a full-size raster,
    // against a budget that is already the tightest thing in the app.
    const raster = colorize(this.pooled, this.resolvedScale(centre), this.raster?.data)
    const reusable =
      this.offscreen !== null &&
      this.offscreen.width === raster.width &&
      this.offscreen.height === raster.height
    const canvas = reusable
      ? (this.offscreen as RasterCanvas)
      : createRasterCanvas(raster.width, raster.height)
    if (!reusable) {
      canvas.width = raster.width
      canvas.height = raster.height
    }
    const ctx = (canvas as HTMLCanvasElement).getContext('2d')
    if (ctx === null) throw new Error('Could not acquire a 2d context for the raster canvas')
    // TypeScript 5.7 made typed arrays generic over their backing buffer, and
    // `ImageData` accepts only a plain `ArrayBuffer`. `rasterize` allocates
    // exactly that; the cast only re-narrows what the public `Uint8ClampedArray`
    // annotation widened to `ArrayBufferLike`.
    //
    // `putImageData` overwrites the destination rectangle wholesale — it does
    // not composite — so a reused canvas needs no clear, and `colorize` writes
    // all four bytes of every pixel including the transparent ones.
    const bytes = raster.data as Uint8ClampedArray<ArrayBuffer>
    ctx.putImageData(new ImageData(bytes, raster.width, raster.height), 0, 0)
    this.raster = raster
    this.offscreen = canvas
    // Every level summarised the pixels that have just been overwritten.
    this.mips = []
    this.dirtyRaster = false
  }

  private strokeBoundary(
    seps: readonly Separator[],
    axis: 'rows' | 'cols',
    n: number
  ): void {
    const ctx = this.ctx
    const plot = this.plotRect
    const data = this.dataRect
    const vertical = axis === 'cols'
    const scale = vertical ? this.colScale : this.rowScale
    const base = vertical ? plot.x : plot.y

    // Three things this loop used to do wrong, all of which only bite at scale
    // — and "at scale" is a whole-metagenome view, which is the one place the
    // dividers matter most.
    //
    // 1. **One path per line.** A `beginPath`/`stroke` pair per separator is a
    //    separate submission to the rasteriser: 2 × (N − 1) of them per frame,
    //    4,094 on a 2,048-unit overview, at whatever rate the pointer moves.
    //    They all share a colour and a width, so they are one path.
    // 2. **No culling.** Every separator was transformed and stroked whether or
    //    not it landed inside the clip. Zoomed to 100 of 24,300 bins, 99.6% of
    //    the work produced no pixels — and zooming *in* made the ratio worse,
    //    because the visible fraction shrinks while the loop length does not.
    // 3. **No de-duplication.** At fit zoom on a 20,000-contig axis, dozens of
    //    boundaries land on the same device pixel; drawing them all is how a
    //    set of hairlines becomes a grey wash.
    //
    // `at` is ascending by construction (`separatorsFor` maps over ordered
    // groups), so the visible window is a contiguous slice and the scan can
    // stop at its far edge.
    const [lo, hi] = scale.domain
    const near = vertical ? data.x : data.y
    const far = near + (vertical ? data.width : data.height)
    let previous = Number.NaN
    let drawn = 0
    ctx.beginPath()
    for (const sep of seps) {
      // `at === 0` is the block edge, not an internal boundary.
      if (sep.at <= 0 || sep.at >= n) continue
      if (sep.at < lo) continue
      if (sep.at > hi) break
      // Snap to the device-pixel grid: a hairline on a fractional coordinate is
      // antialiased into a two-pixel smudge that reads as a real feature.
      const p = this.snap(base + scale.toPixel(sep.at))
      if (p === previous || p < near || p > far) continue
      previous = p
      drawn++
      if (vertical) {
        ctx.moveTo(p, data.y)
        ctx.lineTo(p, data.y + data.height)
      } else {
        ctx.moveTo(data.x, p)
        ctx.lineTo(data.x + data.width, p)
      }
    }
    if (drawn > 0) ctx.stroke()
  }

  /** Put a hairline on the device-pixel grid, so it stays one pixel wide. */
  private snap(raw: number): number {
    return (Math.round(raw * this.dpr - 0.5) + 0.5) / this.dpr
  }

  /**
   * Guide lines through the hovered cell.
   *
   * Drawn through the cell's *centre* rather than its edges: at bin level a
   * cell is often sub-pixel, and two lines around it would be one thick line
   * beside the cell rather than a mark on it. Clipped to the plot so the lines
   * never run through the labels they are helping you find.
   */
  /**
   * Mark where another map's pointer is, as a small cross.
   *
   * Same colour and same weight as the crosshair — it is the same instrument
   * seen from another panel, and a mark in a second colour would read as a
   * second kind of thing. Under the same preference, for the same reason: a
   * reader who has turned the crosshair off has said they do not want a mark
   * following their pointer, and one that appears only on the maps they are
   * *not* pointing at is that answered backwards.
   */
  private drawEcho(): void {
    const cell = this.echoCell
    if (cell === null || this.matrix === null) return
    const plot = this.dataRect
    if (plot.width <= 0 || plot.height <= 0) return
    const origin = this.plotRect
    const x = this.snap(origin.x + this.colScale.toPixel(cell.col + 0.5))
    const y = this.snap(origin.y + this.rowScale.toPixel(cell.row + 0.5))
    if (x < plot.x || x > plot.x + plot.width || y < plot.y || y > plot.y + plot.height) return
    const ctx = this.ctx
    ctx.save()
    ctx.beginPath()
    ctx.rect(plot.x, plot.y, plot.width, plot.height)
    ctx.clip()
    ctx.strokeStyle = this.opts.crosshairColor
    ctx.lineWidth = Math.max(1 / this.dpr, 0.75)
    ctx.beginPath()
    ctx.moveTo(x - ECHO_ARM, y)
    ctx.lineTo(x + ECHO_ARM, y)
    ctx.moveTo(x, y - ECHO_ARM)
    ctx.lineTo(x, y + ECHO_ARM)
    ctx.stroke()
    ctx.restore()
  }

  /**
   * Point at a cell from another panel, or stop.
   *
   * Repaints on a change like {@link setHover}, and unlike it repaints whatever
   * the crosshair preference says — a reader who has moved onto another map of
   * the deck is making the gesture this answers.
   */
  setEchoCell(cell: { row: number; col: number } | null): void {
    const held = this.echoCell
    const same =
      (cell === null && held === null) ||
      (cell !== null && held !== null && cell.row === held.row && cell.col === held.col)
    if (same) return
    this.echoCell = cell
    this.changed()
  }

  /**
   * Say which map is turned, so the guides can be drawn as the map is read.
   *
   * `null` for an ordinary square block, which is every map but one.
   */
  setTurn(turn: { maxSeparation: number; direction: RotateDirection } | null): void {
    const held = this.turn
    const same =
      (turn === null && held === null) ||
      (turn !== null &&
        held !== null &&
        turn.maxSeparation === held.maxSeparation &&
        turn.direction === held.direction)
    if (same) return
    // A band and a square pool differently — one stride for both axes against
    // one per axis ({@link Raster.strideX}) — so arriving at or leaving the turn
    // is a raster to build even when the numbers under it are the same array.
    // `rasterizeNow` would notice on its own through the key; saying it here as
    // well keeps the frame that follows this call from drawing the previous
    // shape's pixels while it works that out.
    if ((turn === null) !== (held === null)) this.dirtyRaster = true
    this.turn = turn
    this.changed()
  }

  private drawCrosshair(): void {
    const cell = this.hoverCell
    if (cell === null || this.matrix === null) return
    const plot = this.dataRect
    const ctx = this.ctx
    ctx.save()
    ctx.beginPath()
    ctx.rect(plot.x, plot.y, plot.width, plot.height)
    ctx.clip()
    ctx.strokeStyle = this.opts.crosshairColor
    ctx.lineWidth = Math.max(1 / this.dpr, 0.75)
    const origin = this.plotRect
    ctx.beginPath()
    const turn = this.turn
    if (turn === null) {
      const x = this.snap(origin.x + this.colScale.toPixel(cell.col + 0.5))
      const y = this.snap(origin.y + this.rowScale.toPixel(cell.row + 0.5))
      ctx.moveTo(x, plot.y)
      ctx.lineTo(x, plot.y + plot.height)
      ctx.moveTo(plot.x, y)
      ctx.lineTo(plot.x + plot.width, y)
    } else {
      // Both edges of the band, so the pair of rays is a whole X wherever the
      // picture has room for one — and, where it has not, exactly the part of an
      // X that fits: a V under a pointer near the diagonal, a ∧ under one near
      // the top. Neither is a special case here; the clip is what makes them.
      //
      // No snap, and that is not an oversight: a 45° line cannot be put on the
      // device grid, and rounding its two ends would move it off the contact it
      // is drawn through rather than sharpen it.
      for (const ray of anchorRays(turnedCentre(turn, cell.row, cell.col), [0, this.matrix.nrows])) {
        ctx.moveTo(
          origin.x + this.colScale.toPixel(ray.from.col),
          origin.y + this.rowScale.toPixel(ray.from.row),
        )
        ctx.lineTo(
          origin.x + this.colScale.toPixel(ray.to.col),
          origin.y + this.rowScale.toPixel(ray.to.row),
        )
      }
    }
    ctx.stroke()
    ctx.restore()
  }

  /**
   * Block boundaries, as rules across the data.
   *
   * Lines rather than boxes, because a box only marks the blocks that appear on
   * *both* axes — the diagonal — and the question a contact map is usually being
   * asked is about the off-diagonal: where does this contig meet that one. A
   * rule crosses every block on its way, so every boundary is visible from
   * anywhere in the picture.
   *
   * Clipped to the data, not to the plot: zoomed out, the matrix is smaller than
   * the area reserved for it, and a divider running on past the last bin claims
   * there is something out there.
   */
  private drawSeparators(): void {
    const { nrows, ncols } = this.dims()
    const plot = this.dataRect
    if (plot.width <= 0 || plot.height <= 0) return
    const ctx = this.ctx
    ctx.save()
    ctx.beginPath()
    ctx.rect(plot.x, plot.y, plot.width, plot.height)
    ctx.clip()

    // A whole-metagenome view puts the genome runs in *both* sets, so the axis
    // is labelled by genome while the heavier stroke lands on the same
    // coordinates. Where the two are literally the same array there is nothing
    // for the fine pass to add, and skipping it halves the stroking.
    ctx.strokeStyle = this.opts.separatorColor
    ctx.lineWidth = Math.max(this.opts.separatorWidth, 1 / this.dpr)
    if (this.separators.groupCols !== this.separators.cols) {
      this.strokeBoundary(this.separators.cols, 'cols', ncols)
    }
    if (this.separators.groupRows !== this.separators.rows) {
      this.strokeBoundary(this.separators.rows, 'rows', nrows)
    }

    // The coarser set on top, heavier: genomes over contigs in a whole-genome
    // view, and selection-block edges everywhere else.
    ctx.strokeStyle = this.opts.groupSeparatorColor
    ctx.lineWidth = Math.max(this.opts.groupSeparatorWidth, 1 / this.dpr)
    this.strokeBoundary(this.separators.groupCols ?? [], 'cols', ncols)
    this.strokeBoundary(this.separators.groupRows ?? [], 'rows', nrows)
    ctx.restore()
  }

  /**
   * Every block of one axis, sorted and cached.
   *
   * Cached because {@link labelPolicy} is consulted on every view change — a
   * pan emits one per frame — and re-sorting 20,000 separators per frame to
   * answer a question about the zoom would be paid by the pan itself.
   */
  private blocks(axis: 'rows' | 'cols'): LabelBlock[] {
    const cached = this.blockCache[axis]
    if (cached !== null) return cached
    const n = axis === 'rows' ? this.dims().nrows : this.dims().ncols
    const blocks = separatorBlocks(this.separators[axis], n)
    this.blockCache[axis] = blocks
    return blocks
  }

  /**
   * The half-open index range of {@link blocks} that the current view shows.
   *
   * Binary search rather than a filter: an axis of 20,000 contigs is walked on
   * every frame of a pan otherwise, and the blocks partition the axis in order,
   * so the visible run is contiguous.
   */
  private visibleRange(axis: 'rows' | 'cols'): [number, number] {
    const blocks = this.blocks(axis)
    if (blocks.length === 0) return [0, 0]
    const [d0, d1] = axis === 'rows' ? this.rowScale.domain : this.colScale.domain
    // First block whose end is past the left edge, and first block starting at
    // or after the right edge.
    const lo = lowerBound(blocks.length, (i) => blocks[i].end > d0)
    const hi = lowerBound(blocks.length, (i) => blocks[i].start >= d1)
    return [lo, Math.max(lo, hi)]
  }

  /**
   * How this axis labels itself at the current zoom.
   *
   * - `all` — few enough blocks *in view* to name every one of them. The count
   *   is of the visible blocks, not of the axis, which is what makes zooming in
   *   on a 20,000-contig overview bring its names out: `maxLabels` asks whether
   *   the labels would be a smear, and past the first zoom step they would not.
   * - `large` — too many to name, but the axis measures cells of a known size,
   *   so the blocks worth naming are the big ones. See {@link labelMinSpan}.
   * - `none` — labels off, no blocks, or too many with nothing to choose by.
   */
  private labelPolicy(axis: 'rows' | 'cols'): 'all' | 'large' | 'none' {
    if (!this.plot.labels) return 'none'
    if (this.blocks(axis).length === 0) return 'none'
    const [lo, hi] = this.visibleRange(axis)
    if (hi - lo <= this.opts.maxLabels) return 'all'
    return this.opts.labelMinSpan > 0 ? 'large' : 'none'
  }

  private isLarge = (block: LabelBlock): boolean =>
    block.end - block.start >= this.opts.labelMinSpan

  /**
   * Boundary ticks outside the data, along the top and left edges.
   *
   * The blocks are whatever the axis is divided into — genomes in the
   * whole-metagenome view, where the reader sends them as the coarse set and
   * they are what both the dividers and the labels use; contigs in a genome;
   * chromosomes in a cooler. Interior boundaries only: the outer two are the
   * plot frame, already drawn.
   *
   * Ticks are elided below {@link BREAK_MIN_GAP} apart, for the same reason
   * labels are — a mark that cannot be told from its neighbours is not a mark,
   * it is a grey band — but the floor is a fraction of the labels', because a
   * tick is a hairline and a name is a word.
   */
  private drawBreaks(): void {
    const plot = this.plotRect
    const data = this.dataRect
    if (data.width <= 0 || data.height <= 0) return
    const ctx = this.ctx
    ctx.save()
    // The gutter is the page, not the figure, so these follow the theme as the
    // labels beside them do — unlike the separators, which are `show.py`'s.
    ctx.strokeStyle = this.opts.labelColor
    ctx.lineWidth = Math.max(1 / this.dpr, 0.75)
    ctx.beginPath()

    const colLength = Math.min(BREAK_LENGTH, data.y)
    if (colLength > 0) {
      let last = -Infinity
      for (const at of this.breakPositions('cols')) {
        const x = this.snap(plot.x + this.colScale.toPixel(at))
        if (x < data.x || x > data.x + data.width) continue
        if (x - last < BREAK_MIN_GAP) continue
        last = x
        ctx.moveTo(x, data.y - colLength)
        ctx.lineTo(x, data.y)
      }
    }

    const rowLength = Math.min(BREAK_LENGTH, data.x)
    if (rowLength > 0) {
      let last = -Infinity
      for (const at of this.breakPositions('rows')) {
        const y = this.snap(plot.y + this.rowScale.toPixel(at))
        if (y < data.y || y > data.y + data.height) continue
        if (y - last < BREAK_MIN_GAP) continue
        last = y
        ctx.moveTo(data.x - rowLength, y)
        ctx.lineTo(data.x, y)
      }
    }
    ctx.stroke()
    ctx.restore()
  }

  /**
   * Interior block boundaries of one axis, in matrix coordinates.
   *
   * From the first *visible* block rather than the first block of the axis, so
   * the cost is the boundaries on screen and not the 20,000 behind them.
   */
  breakPositions(axis: 'rows' | 'cols'): number[] {
    const blocks = this.blocks(axis)
    if (blocks.length < 2) return []
    const [lo, hi] = this.visibleRange(axis)
    // `max(1, lo)`: block zero's start is the axis edge, which the plot frame
    // already draws. Every other visible block's start is a boundary.
    return blocks.slice(Math.max(1, lo), hi).map((block) => block.start)
  }

  /** The blocks drawn on one axis: those in view that the policy admits. */
  labelBlocks(axis: 'rows' | 'cols'): LabelBlock[] {
    const policy = this.labelPolicy(axis)
    if (policy === 'none') return []
    const [lo, hi] = this.visibleRange(axis)
    const visible = this.blocks(axis).slice(lo, hi)
    return policy === 'all' ? visible : visible.filter(this.isLarge)
  }

  /**
   * The blocks the *gutter* is sized for: everything the policy admits over the
   * whole axis, in view or not.
   *
   * Deliberately not {@link labelBlocks}. A gutter measured from the visible
   * labels alone would resize as the widest name scrolled in and out of view,
   * and the plot would shift under the pointer through every pan. Sized this
   * way it changes only when the policy does — at a zoom threshold, once.
   */
  private marginBlocks(axis: 'rows' | 'cols'): LabelBlock[] {
    const policy = this.labelPolicy(axis)
    if (policy === 'none') return []
    const blocks = this.blocks(axis)
    return policy === 'all' ? blocks : blocks.filter(this.isLarge)
  }

  private drawLabels(): void {
    const ctx = this.ctx
    const plot = this.plotRect
    const m = this.computedMargin
    const cols = this.labelBlocks('cols')
    const rows = this.labelBlocks('rows')
    if (cols.length === 0 && rows.length === 0) return

    ctx.save()
    ctx.font = this.opts.labelFont
    ctx.strokeStyle = this.opts.labelHaloColor
    ctx.lineWidth = 3
    ctx.lineJoin = 'round'
    ctx.fillStyle = this.opts.labelColor

    // Columns run a quarter turn anticlockwise, as matplotlib rotates
    // categorical x tick labels: a contig name needs the block's height, and a
    // block is rarely more than a few pixels wide.
    //
    // `inMargin` asks whether the gutter can actually *hold* a rotated label,
    // not merely whether it is non-zero. A 6 px gutter is non-zero and fits
    // nothing, so the old test drew every column label upward off the top of
    // the canvas — present in the DOM, invisible on screen.
    const inMargin = m.top >= LABEL_GAP * 2
    ctx.textBaseline = 'middle'
    ctx.textAlign = inMargin ? 'left' : 'right'
    let last = -Infinity
    for (const block of cols) {
      const centre = plot.x + this.colScale.toPixel(visibleCentre(block, this.colScale.domain))
      if (centre < plot.x || centre > plot.x + plot.width) continue
      if (centre - last < LABEL_MIN_GAP) continue
      last = centre
      ctx.save()
      ctx.translate(centre, plot.y - (inMargin ? 3 : -3))
      ctx.rotate(-Math.PI / 2)
      if (!inMargin) ctx.strokeText(block.label, 0, 0)
      ctx.fillText(block.label, 0, 0)
      ctx.restore()
    }

    const rowsInMargin = m.left >= LABEL_GAP * 2
    ctx.textAlign = rowsInMargin ? 'right' : 'left'
    const rowX = rowsInMargin ? plot.x - 4 : plot.x + 4
    last = -Infinity
    for (const block of rows) {
      const centre = plot.y + this.rowScale.toPixel(visibleCentre(block, this.rowScale.domain))
      if (centre < plot.y || centre > plot.y + plot.height) continue
      if (centre - last < LABEL_MIN_GAP) continue
      last = centre
      if (!rowsInMargin) ctx.strokeText(block.label, rowX, centre)
      ctx.fillText(block.label, rowX, centre)
    }
    ctx.restore()
  }

  /**
   * The ticks one axis would draw at the current zoom, or `[]` when the axis
   * has no single coordinate system. Exposed for the tests, which cannot call
   * `draw` under Node.
   */
  positionTicks(axis: 'rows' | 'cols'): Array<{ bp: number; unit: number }> {
    const coords = axis === 'rows' ? this.axisCoords.rows : this.axisCoords.cols
    if (coords === null) return []
    const scale = axis === 'rows' ? this.rowScale : this.colScale
    const n = axis === 'rows' ? this.dims().nrows : this.dims().ncols
    // The *visible data*, not the visible domain: zoomed out the domain runs
    // past the last bin, and spacing the ticks over that empty margin would put
    // one or two of them on the picture and the rest on nothing.
    const [d0, d1] = scale.domain
    const lo = Math.max(d0, 0)
    const hi = Math.min(d1, n)
    if (!(hi > lo)) return []
    const pixels = (hi - lo) * scale.pixelsPerUnit
    const gap = coords.tickGapPx ?? TICK_MIN_GAP_PX
    const maxTicks = Math.min(MAX_POSITION_TICKS, Math.max(1, Math.floor(pixels / gap)))
    return bpTicks(coords, [lo, hi], maxTicks)
  }

  /**
   * Base-pair coordinates along the bottom and left edges of the data.
   *
   * *Inside* the plot rather than in a gutter, for two reasons. The gutters
   * belong to the block names and collapse to nothing when those are off —
   * which is the app's default — so an outside tick would have to reopen a band
   * the user closed. And the bottom-left of a symmetric contact map is the
   * furthest corner from the diagonal: the emptiest part of the picture, which
   * is where ink costs least.
   *
   * Everything is computed from the axis scales on the frame it is drawn, so
   * the ticks track a pan or a zoom exactly, with no state to keep in step.
   */
  private drawTicks(): void {
    const data = this.dataRect
    if (data.width <= 0 || data.height <= 0) return
    const cols = this.positionTicks('cols')
    const rows = this.positionTicks('rows')
    if (cols.length === 0 && rows.length === 0) return

    const ctx = this.ctx
    const plot = this.plotRect
    ctx.save()
    ctx.beginPath()
    ctx.rect(data.x, data.y, data.width, data.height)
    ctx.clip()
    ctx.font = this.opts.labelFont
    ctx.strokeStyle = this.opts.labelHaloColor
    ctx.lineWidth = 3
    ctx.lineJoin = 'round'
    ctx.fillStyle = this.opts.labelColor

    // The mark is drawn at the position; the *label* is nudged back inside the
    // frame when it would hang over the edge. A tick at 0 bp sits on the first
    // column, and a centred label there is half outside the picture — clipped
    // to "0 b" by the very frame that makes it worth drawing.
    const bottom = data.y + data.height
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    // The gap between two ticks, which is what decides how many digits each one
    // needs — see {@link formatBpTick}. Taken from the ticks themselves rather
    // than recomputed, so it is the step that was actually used.
    const colStep = stepOf(cols)
    for (const tick of cols) {
      const x = this.snap(plot.x + this.colScale.toPixel(tick.unit))
      const text = formatBpTick(tick.bp, colStep)
      const half = ctx.measureText(text).width / 2 + 2
      const at = clamp(x, data.x + half, data.x + data.width - half)
      ctx.strokeText(text, at, bottom - TICK_LENGTH - 3)
      ctx.fillText(text, at, bottom - TICK_LENGTH - 3)
      this.tickMark(x, bottom, x, bottom - TICK_LENGTH)
    }

    // Two perpendicular axes share a corner whichever edges they are put on, so
    // the last row label steps aside for the row of column labels rather than
    // printing on top of it. Its mark stays: the position is still marked, it is
    // the second copy of the number that goes.
    const corner = cols.length === 0 ? bottom : bottom - 20
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    const rowStep = stepOf(rows)
    for (const tick of rows) {
      const y = this.snap(plot.y + this.rowScale.toPixel(tick.unit))
      this.tickMark(data.x, y, data.x + TICK_LENGTH, y)
      const at = clamp(y, data.y + 8, data.y + data.height - 8)
      if (at > corner) continue
      const text = formatBpTick(tick.bp, rowStep)
      ctx.strokeText(text, data.x + TICK_LENGTH + 3, at)
      ctx.fillText(text, data.x + TICK_LENGTH + 3, at)
    }
    ctx.restore()
  }

  /** One tick mark, in the label colour rather than the halo's. */
  private tickMark(x0: number, y0: number, x1: number, y1: number): void {
    const ctx = this.ctx
    ctx.save()
    ctx.strokeStyle = this.opts.labelColor
    ctx.lineWidth = Math.max(1 / this.dpr, 0.75)
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
    ctx.restore()
  }

  // -- input ---------------------------------------------------------------

  /**
   * Keyboard pan and zoom (spec §7.2). Arrows pan by a tenth of the viewport (a
   * half with Shift), `+`/`-` zoom about the centre, `0` or Home refits.
   *
   * @returns `true` if the key was consumed, in which case the default action
   * has already been prevented. The caller still has to redraw.
   */
  handleKeyDown(event: KeyboardEvent): boolean {
    // Escape, while the map is held for a read, calls the read off and gives
    // the gestures back. It is checked before anything else because it is the
    // only key that means something *different* while frozen — and because a
    // held map with no way out is the one failure mode this feature could
    // plausibly have on a large file (see {@link setFrozen}).
    if (this.frozen) {
      if (event.key === 'Escape' && this.onCancelFreeze !== null) {
        const cancel = this.onCancelFreeze
        event.preventDefault()
        cancel()
        return true
      }
      return false
    }
    const plot = this.plotRect
    const step = event.shiftKey ? 0.5 : 0.1
    const cx = plot.x + plot.width / 2
    const cy = plot.y + plot.height / 2
    let handled = true
    switch (event.key) {
      case 'ArrowLeft':
        this.panBy(plot.width * step, 0)
        break
      case 'ArrowRight':
        this.panBy(-plot.width * step, 0)
        break
      case 'ArrowUp':
        this.panBy(0, plot.height * step)
        break
      case 'ArrowDown':
        this.panBy(0, -plot.height * step)
        break
      case '+':
      case '=':
        this.zoomAt(cx, cy, 1.25)
        break
      case '-':
      case '_':
        this.zoomAt(cx, cy, 1 / 1.25)
        break
      case '0':
      case 'Home':
        this.fit()
        break
      default:
        handled = false
    }
    if (handled) event.preventDefault()
    return handled
  }

  /**
   * Wire mouse drag, wheel zoom, click and keyboard to the canvas. The canvas
   * takes `tabIndex = 0` so it can receive key events. Idempotent.
   */
  attach(): void {
    if (this.detachFns.length > 0) return
    const canvas = this.canvas
    if (canvas.tabIndex < 0) canvas.tabIndex = 0

    const local = (e: MouseEvent): [number, number] => {
      const r = this.clientRect()
      return [e.clientX - r.left, e.clientY - r.top]
    }

    /**
     * A drag pans; Option (Alt) turns it into a zoom selection.
     *
     * The two were the other way round, and moving a map is the thing a hand on
     * a mouse expects a drag to do. Selecting a region to zoom into is the
     * deliberate action, so it takes the deliberate modifier.
     */
    const wantsSelect = (e: MouseEvent): boolean => e.altKey

    /**
     * The cursor stays the drawn arrowhead at rest — it is the one that points
     * *at* a cell — and only changes to say what is happening: a crosshair while
     * Option is held, the closed hand while a pan is under way.
     */
    const showCursor = (options: { selecting?: boolean; grabbing?: boolean }): void => {
      if (options.selecting !== undefined) canvas.classList.toggle('selecting', options.selecting)
      if (options.grabbing !== undefined) canvas.classList.toggle('grabbing', options.grabbing)
    }

    /**
     * A click opens what the cell refers to, but only after the double-click
     * window has passed: the second click of a "reset the zoom" would otherwise
     * land after the first had already navigated away.
     */
    let clickTimer: ReturnType<typeof setTimeout> | null = null
    const cancelPendingClick = (): void => {
      if (clickTimer === null) return
      clearTimeout(clickTimer)
      clickTimer = null
    }

    /**
     * A gesture in progress is followed on the window, not on the canvas.
     *
     * The canvas stops hearing about a pointer the moment it leaves, and a
     * marquee dragged into the corner of the data — the commonest one there is,
     * because the corner of the data is usually near the corner of the plot —
     * leaves. Listening on the window for the length of the drag is how every
     * other drag on the page behaves; the positions are clamped into the plot on
     * arrival, so following the pointer out does not follow the selection out.
     *
     * Attached only while the button is down. A permanent window listener would
     * cost a measure-and-hit-test on every pointer move anywhere on the page.
     */
    const dragHost: Window | undefined = typeof window === 'undefined' ? undefined : window
    let following = false
    const follow = (on: boolean): void => {
      if (on === following || dragHost === undefined) return
      following = on
      const bind = on ? dragHost.addEventListener : dragHost.removeEventListener
      bind.call(dragHost, 'mousemove', onMove as EventListener)
      bind.call(dragHost, 'mouseup', onUp as EventListener)
      // Escape belongs to the gesture, so it is listened for exactly as long as
      // the gesture lasts. Capturing, because a marquee is very often begun
      // without the canvas ever taking the focus — the press that would have
      // given it focus is the press that started the drag — and the key would
      // otherwise be read by whatever the reader last clicked on.
      bind.call(dragHost, 'keydown', onAbort as EventListener, true)
    }

    /**
     * Escape abandons a drag in progress, leaving the view where it was.
     *
     * The way out of a gesture that has gone wrong. A marquee is committed on
     * release and a release cannot be taken back, so without this the only way
     * to undo a box drawn in the wrong place was to let it open the wrong region
     * and then navigate back — and a pan half-way through a drag had no way out
     * at all. The pan is *rewound* rather than simply stopped: a pan that ends
     * where the reader changed their mind is not a cancellation, it is the pan
     * happening anyway.
     */
    const onAbort = (e: KeyboardEvent): void => {
      const drag = this.drag
      if (e.key !== 'Escape' || drag === null) return
      e.preventDefault()
      e.stopPropagation()
      this.drag = null
      this.dragMoved = false
      follow(false)
      showCursor({ grabbing: false })
      if (drag.mode === 'pan') this.panBy(drag.x0 - this.lastX, drag.y0 - this.lastY)
      this.changed()
    }

    const onDown = (e: MouseEvent): void => {
      // The primary button only. `mousedown` fires for every button, and a press
      // that is not answered by a matching `mouseup` guard becomes a *click* on
      // release: right-clicking the map navigated to whatever the cell under it
      // referred to, which on a whole-genome view is a different picture
      // entirely, and the menu the press was for opened over the view it had
      // just left. There is nothing to do here for the other buttons — the
      // context menu is a `contextmenu` listener of its own.
      if (e.button !== 0) return
      const [x, y] = local(e)
      this.dragMoved = false
      // Three gestures on one button, told apart by the modifiers. Option
      // selects a box to open; Option with Shift does the same on the diagonal;
      // **Shift alone** names a band of one axis and zooms to it, which is the
      // 1D half of the same idea and the gesture the 1D browser has too.
      // Everything else pans.
      //
      // …**except while a form is waiting to be pointed at.** *Pick on map* is a
      // mode with a lit button and a changed cursor saying so, and asking for a
      // held modifier on top of that is asking twice: a reader who has just
      // pressed a button that says "pick on map" is going to drag on the map. So
      // while it is armed a plain drag names the band, and `finishBand` reports
      // it without zooming — the only thing the gesture does is answer the
      // question the form asked. It disarms on the first pick, so the next drag
      // is an ordinary pan again (`ui/mapPick.ts`).
      const mode =
        this.bandMode === 'pick' ? 'band' : wantsSelect(e) ? 'select' : e.shiftKey ? 'band' : 'pan'
      // …except on a turned map, where the diagonal is the bottom edge of the
      // picture and a corner snapped to it would be a corner snapped to the
      // frame. The selection is already the on-diagonal one there, whichever
      // modifiers are held ({@link setSpanGestures}).
      const diagonal = mode === 'select' && e.shiftKey && !this.spanGestures
      const [ax, ay] = diagonal ? this.onDiagonal(x, y) : [x, y]
      this.drag = { mode, x0: ax, y0: ay, x: ax, y: ay, diagonal }
      this.lastX = x
      this.lastY = y
      follow(true)
      showCursor({ grabbing: this.drag.mode === 'pan' })
      // The readout is about where the pointer *was*: a drag stops feeding it,
      // so left up it sits over a marquee naming a cell the picture no longer
      // has under the pointer — and, on a selection, directly over the
      // coordinates the drag is drawing. The 1D browser puts its tooltip away on
      // every press for the same reason.
      this.setHover(null)
      this.onHover?.(null)
      // `preventScroll`, because focusing an element the scroll container has
      // only partly in view *scrolls it into view* — and the press that just
      // took the focus is measured again on release, against a canvas that has
      // since moved under the still-stationary pointer. Two pixels of scroll is
      // six contigs at a fitted 2,048-contig overview: the click opened the
      // wrong pair, a little below the cell the tooltip had just named.
      canvas.focus({ preventScroll: true })
    }
    const onMove = (e: MouseEvent): void => {
      const [x, y] = local(e)
      const drag = this.drag
      showCursor({ selecting: drag === null ? wantsSelect(e) : drag.mode === 'select' })
      if (drag !== null) {
        if (Math.abs(x - drag.x0) + Math.abs(y - drag.y0) > 2) this.dragMoved = true
        if (drag.mode === 'pan') {
          this.panBy(x - this.lastX, y - this.lastY)
          this.lastX = x
          this.lastY = y
        } else {
          // Clamped into the plot rather than followed out of it. A corner
          // dragged past the edge of the data is a corner nobody can act on, and
          // abandoning the gesture there — which is what leaving the canvas used
          // to do — throws away a selection whose *other* three sides were
          // exactly where the reader put them.
          const plot = this.plotRect
          const [cx, cy] = [
            clamp(x, plot.x, plot.x + plot.width),
            clamp(y, plot.y, plot.y + plot.height),
          ]
          // Both corners on the diagonal, not just the anchor. The two axes
          // share a zoom — `syncScales` gives each `pixelsPerUnit === zoom` —
          // so two points on the line are already an equal-sided box, and
          // `squareFrom` has nothing left to square.
          const [nx, ny] = drag.diagonal ? this.onDiagonal(cx, cy) : [cx, cy]
          drag.x = nx
          drag.y = ny
        }
        this.changed()
        return
      }
      this.hoverPoint = { x, y }
      hoverAt(x, y, wantsSelect(e) && e.shiftKey)
    }

    /**
     * Report the cell under a point, snapping onto the diagonal while the
     * diagonal-locked marquee's modifiers are held.
     *
     * The same rule that marquee follows, applied to the pointer
     * before a drag has begun — so the reading a reader gets is the reading the
     * gesture would select from, and they can see *where on the diagonal* they
     * are about to start before pressing the button. It answers the question a
     * hand hovering over a contact map is usually asking anyway: contact at this
     * locus with itself is the reference every off-diagonal cell is read
     * against, and finding the diagonal by eye at a fitted whole-genome view is
     * a two-pixel target on a 45° line.
     *
     * Only the *readout* moves, not the pointer: the arrowhead stays where the
     * hand put it, and the crosshair — which is what says "this is the cell I am
     * naming" — is drawn at the snapped position.
     */
    const hoverAt = (x: number, y: number, held: boolean): void => {
      // Off on a turned map, where every reading is already measured from the
      // diagonal and the snap would be onto the picture's own bottom edge.
      const diagonal = held && !this.spanGestures
      const [hx, hy] = diagonal ? this.onDiagonal(x, y) : [x, y]
      const cell = this.cellAt(hx, hy)
      this.setHover(cell)
      canvas.classList.toggle('on-diagonal', diagonal && cell !== null)
      // A label opens something, so it says so under the pointer. Measured at
      // the *pointer*, never at the snapped point: a label is a thing being
      // pointed at, and the diagonal never runs through the gutters.
      canvas.classList.toggle(
        'linking',
        cell === null && this.onLabelClick !== null && this.labelAt(x, y) !== null,
      )
      this.onHover?.(cell, { x: hx, y: hy })
    }

    /**
     * Shift pressed or released with the pointer standing still.
     *
     * The snap belongs to the modifier rather than to the movement, so it has to
     * happen the moment the key goes down — a reader who presses Shift while
     * hovering and sees nothing move concludes the feature is not there. On the
     * window, because hovering does not take the focus and the canvas would only
     * hear this after a click.
     */
    const onShift = (e: KeyboardEvent): void => {
      if (e.key !== 'Shift' || this.hoverPoint === null || this.drag !== null) return
      hoverAt(this.hoverPoint.x, this.hoverPoint.y, e.type === 'keydown')
    }
    /**
     * The canvas's own move handler, which steps aside once `follow` is on: the
     * event bubbles from the canvas to the window, so the two would otherwise
     * both answer a move made over the plot and repaint the frame twice.
     *
     * `following` rather than "is a drag in progress", and the difference is not
     * pedantic: where there is no `window` to listen on — a headless test, an
     * embedding without one — nothing is following, and a handler that stood
     * aside for a listener that was never attached would make the canvas deaf
     * for the whole of every drag.
     */
    const onCanvasMove = (e: MouseEvent): void => {
      if (!following) onMove(e)
    }
    const onUp = (e: MouseEvent): void => {
      const drag = this.drag
      this.drag = null
      follow(false)
      showCursor({ grabbing: false })
      // Runs twice for a release over the canvas — once at the target, once on
      // the window the event bubbles to — and the second call finds no drag.
      if (drag === null) return
      const [x, y] = local(e)
      // A press that did not travel is a click, in either mode: §5.5's
      // cross-navigation must not need a steady hand.
      if (!this.dragMoved) {
        // …but not while a form is waiting for a locus. A tap there names the
        // bin under the pointer, which is the finest anchor this resolution can
        // express, and navigating to whatever the cell refers to would take the
        // form that asked the question off the screen.
        if (this.bandMode === 'pick') {
          this.finishBand(drag.x0, drag.y0, drag.x, drag.y)
          this.changed()
          return
        }
        const action = this.hitAction(x, y)
        if (action === null) return
        // Deferred behind the double-click window: the second click of a "put
        // it back" must not land after the first has navigated away.
        cancelPendingClick()
        clickTimer = setTimeout(() => {
          clickTimer = null
          action()
        }, DOUBLE_CLICK_MS)
        return
      }
      // `drag.x/y`, not the release position: the corner the reader saw is the
      // clamped, diagonal-locked one the marquee was drawn to, and a release
      // outside the canvas has no meaningful position at all.
      if (drag.mode === 'select') this.finishSelection(drag.x0, drag.y0, drag.x, drag.y)
      if (drag.mode === 'band') this.finishBand(drag.x0, drag.y0, drag.x, drag.y)
      this.changed()
    }
    const onDoubleClick = (e: MouseEvent): void => {
      e.preventDefault()
      // Beats the pending single click, which is the point: this is "put it
      // back", not "go there and put it back".
      cancelPendingClick()
      this.fit()
      this.changed()
    }
    const onLeave = (): void => {
      // The *hover* leaves; the drag does not. A gesture in progress belongs to
      // the hand that started it, and it is followed on the window until the
      // button comes up — with every position clamped into the plot, so a corner
      // dragged past the edge stops at the edge instead of taking the whole
      // selection with it. Abandoning here is what made a marquee dragged to the
      // corner of the data — the commonest one there is — disappear.
      this.hoverPoint = null
      this.setHover(null)
      this.onHover?.(null)
      canvas.classList.remove('on-diagonal')
      if (this.drag === null) showCursor({ selecting: false, grabbing: false })
    }
    const onWheel = (e: WheelEvent): void => {
      // **A sideways scroll slides along the map**, which is what a trackpad's
      // two fingers mean in every genome browser there is — and what they
      // already meant over the 1D browser's tracks, so a reader who learned the
      // gesture on one surface found it doing nothing on the other. It used to
      // be left alone so the browser's back/forward gesture would work here as
      // it does over the rest of the page; that is the wrong trade over a
      // picture you navigate by sliding. Back and forward are still a sideways
      // swipe *outside* the picture, which is where a page gesture belongs.
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault()
        this.panBy(-e.deltaX, 0)
        return
      }
      e.preventDefault()
      const [x, y] = local(e)
      // Exponential in the wheel delta so a trackpad's many small events and a
      // mouse wheel's few large ones compose to the same total zoom.
      this.zoomAt(x, y, Math.exp(-e.deltaY * 0.002))
      this.changed()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (this.handleKeyDown(e)) this.changed()
    }

    /**
     * Touch: one finger pans, two pinch, a tap opens, a double tap refits.
     *
     * A separate path from the mouse rather than a rewrite of it into pointer
     * events. Pinch has no mouse equivalent to fold into, the modifier that
     * turns a mouse drag into a zoom selection does not exist on a phone, and
     * `preventDefault` here is what stops the browser from panning the *page*
     * under the finger and from firing the synthetic mouse events that would
     * otherwise run every gesture twice.
     */
    const touchPoints = (e: TouchEvent): Array<[number, number]> => {
      const r = this.clientRect()
      return Array.from(e.touches, (t) => [t.clientX - r.left, t.clientY - r.top])
    }
    const centre = (points: Array<[number, number]>): [number, number] => [
      points.reduce((sum, p) => sum + p[0], 0) / points.length,
      points.reduce((sum, p) => sum + p[1], 0) / points.length,
    ]
    const spread = (points: Array<[number, number]>): number =>
      Math.hypot(points[0][0] - points[1][0], points[0][1] - points[1][1])

    let pinchDistance = 0
    let touchMoved = false
    let touchStart: [number, number] = [0, 0]
    // Not `0`: `timeStamp` is milliseconds since the page loaded, so a first tap
    // inside the first quarter-second of the document's life would arrive
    // "within the double-tap window" of a tap that never happened.
    let lastTapAt = Number.NEGATIVE_INFINITY

    const onTouchStart = (e: TouchEvent): void => {
      const points = touchPoints(e)
      if (points.length === 0) return
      e.preventDefault()
      touchMoved = false
      touchStart = points[0]
      this.lastX = points[0][0]
      this.lastY = points[0][1]
      pinchDistance = points.length >= 2 ? spread(points) : 0
    }
    const onTouchMove = (e: TouchEvent): void => {
      const points = touchPoints(e)
      if (points.length === 0) return
      e.preventDefault()
      if (points.length >= 2) {
        // Pinch about the midpoint of the two fingers, and pan by however far
        // that midpoint travelled: the two are one gesture, and handling only
        // the scale makes a two-finger drag feel nailed down.
        const [cx, cy] = centre(points)
        const distance = spread(points)
        if (pinchDistance > 0 && distance > 0) this.zoomAt(cx, cy, distance / pinchDistance)
        this.panBy(cx - this.lastX, cy - this.lastY)
        pinchDistance = distance
        this.lastX = cx
        this.lastY = cy
        touchMoved = true
        this.changed()
        return
      }
      const [x, y] = points[0]
      if (Math.abs(x - touchStart[0]) + Math.abs(y - touchStart[1]) > 6) touchMoved = true
      this.panBy(x - this.lastX, y - this.lastY)
      this.lastX = x
      this.lastY = y
      this.changed()
    }
    const onTouchEnd = (e: TouchEvent): void => {
      if (e.touches.length > 0) {
        // A finger lifted mid-pinch: re-anchor on what is left rather than
        // treating the survivor's position as a jump.
        const points = touchPoints(e)
        const [cx, cy] = centre(points)
        this.lastX = cx
        this.lastY = cy
        pinchDistance = points.length >= 2 ? spread(points) : 0
        return
      }
      e.preventDefault()
      pinchDistance = 0
      if (touchMoved) return
      const now = e.timeStamp
      if (now - lastTapAt < DOUBLE_CLICK_MS) {
        // A second tap in the double-tap window is "put it back", and it must
        // beat the first tap's pending navigation.
        lastTapAt = 0
        cancelPendingClick()
        this.fit()
        this.changed()
        return
      }
      lastTapAt = now
      const cell = this.cellAt(touchStart[0], touchStart[1])
      // The tooltip is the readout a phone has no hover for, so a tap fills it
      // in on the way to opening what was tapped.
      this.setHover(cell)
      this.onHover?.(cell, { x: touchStart[0], y: touchStart[1] })
      // A label is as tappable as a cell, and on a phone it is the easier of
      // the two to hit: the gutter is a band, the cell is a few pixels.
      const action = this.hitAction(touchStart[0], touchStart[1])
      if (action === null) return
      cancelPendingClick()
      clickTimer = setTimeout(() => {
        clickTimer = null
        action()
      }, DOUBLE_CLICK_MS)
    }

    canvas.addEventListener('mousedown', onDown)
    canvas.addEventListener('mousemove', onCanvasMove)
    canvas.addEventListener('mouseup', onUp)
    canvas.addEventListener('dblclick', onDoubleClick)
    canvas.addEventListener('mouseleave', onLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('keydown', onKey)
    // Not passive: every one of these calls `preventDefault`, and a passive
    // listener that does so is ignored with a console warning.
    canvas.addEventListener('touchstart', onTouchStart, { passive: false })
    canvas.addEventListener('touchmove', onTouchMove, { passive: false })
    canvas.addEventListener('touchend', onTouchEnd, { passive: false })
    canvas.addEventListener('touchcancel', onTouchEnd, { passive: false })
    // The cached canvas origin (see `clientRect`) moves when the page scrolls.
    // Captured on the window so an ancestor's scroll is seen too, and passive
    // because this only invalidates a number.
    const onScroll = (): void => {
      this.rectCache = null
    }
    const scrollHost: { addEventListener?: typeof window.addEventListener } | undefined =
      typeof window === 'undefined' ? undefined : window
    scrollHost?.addEventListener?.('scroll', onScroll, { capture: true, passive: true })
    // Shift is watched on the window rather than on the canvas: hovering takes
    // no focus, so the canvas hears no keys until something has been clicked.
    scrollHost?.addEventListener?.('keydown', onShift as EventListener)
    scrollHost?.addEventListener?.('keyup', onShift as EventListener)

    this.detachFns = [
      () => window?.removeEventListener?.('scroll', onScroll, { capture: true }),
      () => window?.removeEventListener?.('keydown', onShift as EventListener),
      () => window?.removeEventListener?.('keyup', onShift as EventListener),
      () => canvas.removeEventListener('mousedown', onDown),
      () => canvas.removeEventListener('mousemove', onCanvasMove),
      () => canvas.removeEventListener('mouseup', onUp),
      () => canvas.removeEventListener('dblclick', onDoubleClick),
      () => cancelPendingClick(),
      // A view torn down mid-drag would otherwise leave the window listening.
      () => follow(false),
      () => canvas.removeEventListener('mouseleave', onLeave),
      () => canvas.removeEventListener('wheel', onWheel),
      () => canvas.removeEventListener('keydown', onKey),
      () => canvas.removeEventListener('touchstart', onTouchStart),
      () => canvas.removeEventListener('touchmove', onTouchMove),
      () => canvas.removeEventListener('touchend', onTouchEnd),
      () => canvas.removeEventListener('touchcancel', onTouchEnd),
    ]
  }

  /**
   * Record the hovered cell, repainting only when the crosshair is on and the
   * cell actually changed. With it off this is a field assignment, so pointer
   * moves stay free — the §12 budget is for the frames a *drag* costs, and a
   * redraw per mousemove would spend it on a line nobody asked to see.
   */
  private setHover(cell: Cell | null): void {
    const same =
      (cell === null && this.hoverCell === null) ||
      (cell !== null &&
        this.hoverCell !== null &&
        cell.row === this.hoverCell.row &&
        cell.col === this.hoverCell.col)
    this.hoverCell = cell
    this.syncGuidedCursor()
    if (!same && this.plot.crosshair) this.changed()
  }

  /**
   * Hide the drawn pointer exactly where the crosshair replaces it.
   *
   * The guide lines are a better pointer than the arrowhead: they are drawn at
   * the cell this view has actually resolved, they run the whole width and
   * height of the picture, and the lanes continue them. The arrowhead beside
   * them is a second, blunter mark for the same position — and it sits *on* the
   * pixel it is pointing at, which on a map where a cell can be one pixel is the
   * only thing covering the answer.
   *
   * Condition for condition with the line, not merely with the preference: over
   * a label gutter there is no cell, so no crosshair is drawn, and there the
   * arrowhead is still the only thing saying where the hand is. The transient
   * cursors — the closed hand while panning, the crosshair while Option is held
   * — win over this in the stylesheet, because they say what is *happening*,
   * which no guide line does.
   */
  private syncGuidedCursor(): void {
    this.canvas.classList.toggle('is-guided', this.plot.crosshair && this.hoverCell !== null)
  }

  /** Remove every listener {@link attach} installed. Idempotent. */
  detach(): void {
    for (const fn of this.detachFns) fn()
    this.detachFns = []
    if (this.selfFrame !== 0) {
      cancelAnimationFrame(this.selfFrame)
      this.selfFrame = 0
    }
  }
}

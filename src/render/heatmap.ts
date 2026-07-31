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
import type { ColorScale, DenseMatrix, Separator } from '../types'
import { applyColormap, colormapIndex } from './colormaps'
import { Scale, autoVmax, transformValues } from './scale'

// ---------------------------------------------------------------------------
// Rasterisation — pure, no canvas, so it is testable under Node
// ---------------------------------------------------------------------------

/** RGBA bytes at matrix resolution, plus the colour scale actually used. */
export interface Raster {
  /** Matrix columns. */
  width: number
  /** Matrix rows. */
  height: number
  /** `width * height * 4` bytes, row-major, ready for `new ImageData(...)`. */
  data: Uint8ClampedArray
  /** The scale with `vmin`/`vmax` resolved, so the colourbar can reuse it. */
  scale: ColorScale
  /** The transformed values, kept so colourbar and tooltips cannot disagree. */
  transformed: Float32Array
}

/**
 * Colour every cell of `matrix` into RGBA bytes.
 *
 * `scale.vmax` is honoured when finite and recomputed by {@link autoVmax}
 * otherwise — pass `NaN` to ask for the `metacooler show` default. `vmin` is
 * likewise defaulted to `0`, which is the only value the CLI ever uses.
 *
 * NaN cells come out fully transparent rather than as a colour. That is
 * matplotlib's default "bad" colour and it is the diagnostically correct
 * result: a blank row is an unbalanced row (spec §6.4), and painting it black
 * or white would make it indistinguishable from a genuinely empty region.
 */
export function rasterize(matrix: DenseMatrix, scale: ColorScale): Raster {
  const { nrows, ncols, values } = matrix
  const n = nrows * ncols
  const transformed = transformValues(values, scale.transform)

  const vmin = Number.isFinite(scale.vmin) ? scale.vmin : 0
  const vmax = Number.isFinite(scale.vmax) ? scale.vmax : autoVmax(transformed)
  const span = vmax - vmin

  const lut = applyColormap(scale.colormap)
  const data = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    // matplotlib's `Normalize` collapses a degenerate range to 0 rather than
    // dividing by zero, so a constant matrix renders as the colormap's low end.
    const t = span > 0 ? (transformed[i] - vmin) / span : 0
    const k = colormapIndex(t)
    const o = i * 4
    if (k < 0) {
      data[o + 3] = 0
      continue
    }
    const s = k * 4
    data[o] = lut[s]
    data[o + 1] = lut[s + 1]
    data[o + 2] = lut[s + 2]
    data[o + 3] = lut[s + 3]
  }

  return { width: ncols, height: nrows, data, scale: { ...scale, vmin, vmax }, transformed }
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
  /** Draw labels only when an axis has at most this many blocks. */
  maxLabels?: number
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
   * Fired as the pointer moves over the plot; `null` when it leaves.
   *
   * `at` is the pointer in canvas CSS pixels, so a tooltip can be positioned
   * without the listener re-deriving coordinates the view has already computed.
   * Absent on the leave event, where there is no position.
   */
  onHover?: (cell: Cell | null, at?: { x: number; y: number }) => void
}

type ResolvedOptions = Required<
  Omit<HeatmapOptions, 'margin' | 'onChange' | 'onCellClick' | 'onHover'>
> & { margin: Margin }

const DEFAULT_MARGIN: Margin = { top: 0, right: 0, bottom: 0, left: 0 }

/** Minimum on-screen gap between two drawn labels, in CSS pixels. */
const LABEL_MIN_GAP = 11

/** Breathing room between a label and the plot edge, in CSS pixels. */
const LABEL_GAP = 8

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
  private readonly ctx: CanvasRenderingContext2D
  private readonly opts: ResolvedOptions
  private readonly onChange: (() => void) | null
  private readonly onCellClick: ((cell: Cell) => void) | null
  private readonly onHover: ((cell: Cell | null, at?: { x: number; y: number }) => void) | null

  private matrix: DenseMatrix | null = null
  private raster: Raster | null = null
  private offscreen: RasterCanvas | null = null
  private separators: SeparatorSet = EMPTY_SEPARATORS
  private colorScale: ColorScale
  private dirtyRaster = false

  private cssWidth = 0
  private cssHeight = 0
  private dpr = 1

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

  /**
   * The margin in force. Equals `opts.margin` unless `autoMargin` is set, in
   * which case {@link measureMargin} recomputes it whenever the labels or the
   * canvas size change.
   */
  private computedMargin: Margin

  private detachFns: Array<() => void> = []
  private dragging = false
  private dragMoved = false
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
      labelFont: options.labelFont ?? '10px system-ui, sans-serif',
      maxLabels: options.maxLabels ?? MAX_CATEGORICAL_TICKS,
      autoMargin: options.autoMargin ?? false,
      devicePixelRatio: options.devicePixelRatio ?? 0,
      minVisibleCells: options.minVisibleCells ?? 4,
      maxZoomOut: options.maxZoomOut ?? 4,
    }
    this.computedMargin = this.opts.margin
    this.onChange = options.onChange ?? null
    this.onCellClick = options.onCellClick ?? null
    this.onHover = options.onHover ?? null

    // The `metacooler show` defaults, verbatim (spec §7.1). `vmax: NaN` means
    // "the 99th percentile of the non-zero transformed values", recomputed on
    // every view change until the user overrides it.
    this.colorScale = { vmin: 0, vmax: Number.NaN, transform: 'log1p', colormap: 'afmhot_r' }
    this.resize()
  }

  // -- geometry ------------------------------------------------------------

  /** The margin actually in force, after any {@link measureMargin} pass. */
  get margin(): Margin {
    return this.computedMargin
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
    const cols = this.labelBlocks('cols')
    const rows = this.labelBlocks('rows')
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
   * Re-read the canvas's CSS size and device pixel ratio and resize its backing
   * store. Call on a container resize; it never re-rasterises, because the
   * raster is at *matrix* resolution and is independent of the viewport.
   */
  resize(cssWidth?: number, cssHeight?: number): void {
    const w = cssWidth ?? this.canvas.clientWidth
    const h = cssHeight ?? this.canvas.clientHeight
    this.cssWidth = w > 0 ? w : this.canvas.width || 1
    this.cssHeight = h > 0 ? h : this.canvas.height || 1
    this.dpr = this.opts.devicePixelRatio > 0 ? this.opts.devicePixelRatio : detectDpr()
    this.canvas.width = Math.max(1, Math.round(this.cssWidth * this.dpr))
    this.canvas.height = Math.max(1, Math.round(this.cssHeight * this.dpr))
    // The cap is a fraction of the canvas, so a resize can change the gutters
    // even though the labels have not changed.
    this.measureMargin()
    this.recomputeBaseZoom()
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
   */
  setMatrix(matrix: DenseMatrix, separators: Separator[] | SeparatorSet = []): void {
    this.matrix = matrix
    this.separators = Array.isArray(separators)
      ? { rows: separators, cols: separators }
      : separators
    this.dirtyRaster = true
    this.rowScale.setFull([0, Math.max(1, matrix.nrows)])
    this.colScale.setFull([0, Math.max(1, matrix.ncols)])
    // Before `fit`, which divides by the plot area the gutters determine.
    this.measureMargin()
    this.fit()
  }

  /**
   * Set the colour scale. Pass `vmax: NaN` for the `metacooler show` default —
   * the 99th percentile of the non-zero transformed values — which is then
   * recomputed on every matrix change, as spec §7.1 requires.
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

  /** Fit the whole matrix into the plot area and centre it. */
  fit(): void {
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

  private dims(): { nrows: number; ncols: number } {
    return this.matrix === null
      ? { nrows: 1, ncols: 1 }
      : { nrows: Math.max(1, this.matrix.nrows), ncols: Math.max(1, this.matrix.ncols) }
  }

  private recomputeBaseZoom(): void {
    const plot = this.plotRect
    const { nrows, ncols } = this.dims()
    const k = Math.min(plot.width / ncols, plot.height / nrows)
    this.baseZoom = k > 0 && Number.isFinite(k) ? k : 1
  }

  private minZoom(): number {
    return this.baseZoom / this.opts.maxZoomOut
  }

  private maxZoom(): number {
    const plot = this.plotRect
    return Math.max(
      this.baseZoom,
      Math.min(plot.width, plot.height) / this.opts.minVisibleCells
    )
  }

  private clampView(): void {
    this.zoom = clamp(this.zoom, this.minZoom(), this.maxZoom())
    const plot = this.plotRect
    const { nrows, ncols } = this.dims()
    const visW = plot.width / this.zoom
    const visH = plot.height / this.zoom
    // Allow the matrix to be pushed half a viewport off either edge, so a
    // corner of a large map can be brought to the centre of the screen, but no
    // further — panning off into empty space is a bug report waiting to happen.
    this.originX = clamp(this.originX, -visW / 2, ncols - visW / 2)
    this.originY = clamp(this.originY, -visH / 2, nrows - visH / 2)
  }

  private syncScales(): void {
    const plot = this.plotRect
    this.colScale.setPixels(plot.width)
    this.rowScale.setPixels(plot.height)
    this.colScale.setDomain([this.originX, this.originX + plot.width / this.zoom])
    this.rowScale.setDomain([this.originY, this.originY + plot.height / this.zoom])
  }

  private changed(): void {
    this.onChange?.()
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

  // -- drawing -------------------------------------------------------------

  /** Rasterise if needed, then paint. Cheap enough to call every frame. */
  draw(): void {
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
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
    ctx.imageSmoothingEnabled = this.zoom < 1

    const k = this.zoom * this.dpr
    ctx.setTransform(
      k,
      0,
      0,
      k,
      this.dpr * (plot.x - this.originX * this.zoom),
      this.dpr * (plot.y - this.originY * this.zoom)
    )
    ctx.drawImage(offscreen, 0, 0)
    ctx.restore()

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.drawSeparators()
    this.drawLabels()
  }

  private rasterizeNow(): void {
    if (this.matrix === null) return
    const raster = rasterize(this.matrix, this.colorScale)
    const canvas = createRasterCanvas(raster.width, raster.height)
    canvas.width = raster.width
    canvas.height = raster.height
    const ctx = (canvas as HTMLCanvasElement).getContext('2d')
    if (ctx === null) throw new Error('Could not acquire a 2d context for the raster canvas')
    // TypeScript 5.7 made typed arrays generic over their backing buffer, and
    // `ImageData` accepts only a plain `ArrayBuffer`. `rasterize` allocates
    // exactly that; the cast only re-narrows what the public `Uint8ClampedArray`
    // annotation widened to `ArrayBufferLike`.
    const bytes = raster.data as Uint8ClampedArray<ArrayBuffer>
    ctx.putImageData(new ImageData(bytes, raster.width, raster.height), 0, 0)
    this.raster = raster
    this.offscreen = canvas
    this.dirtyRaster = false
  }

  private strokeBoundary(
    seps: readonly Separator[],
    axis: 'rows' | 'cols',
    n: number
  ): void {
    const ctx = this.ctx
    const plot = this.plotRect
    const vertical = axis === 'cols'
    const scale = vertical ? this.colScale : this.rowScale
    const base = vertical ? plot.x : plot.y
    for (const sep of seps) {
      // `at === 0` is the block edge, not an internal boundary.
      if (sep.at <= 0 || sep.at >= n) continue
      // Snap to the device-pixel grid: a hairline on a fractional coordinate is
      // antialiased into a two-pixel smudge that reads as a real feature.
      const raw = base + scale.toPixel(sep.at)
      const p = (Math.round(raw * this.dpr - 0.5) + 0.5) / this.dpr
      ctx.beginPath()
      if (vertical) {
        ctx.moveTo(p, plot.y)
        ctx.lineTo(p, plot.y + plot.height)
      } else {
        ctx.moveTo(plot.x, p)
        ctx.lineTo(plot.x + plot.width, p)
      }
      ctx.stroke()
    }
  }

  private drawSeparators(): void {
    const { nrows, ncols } = this.dims()
    const plot = this.plotRect
    const ctx = this.ctx
    ctx.save()
    ctx.beginPath()
    ctx.rect(plot.x, plot.y, plot.width, plot.height)
    ctx.clip()

    ctx.strokeStyle = this.opts.separatorColor
    ctx.lineWidth = Math.max(this.opts.separatorWidth, 1 / this.dpr)
    this.strokeBoundary(this.separators.cols, 'cols', ncols)
    this.strokeBoundary(this.separators.rows, 'rows', nrows)

    ctx.strokeStyle = this.opts.groupSeparatorColor
    ctx.lineWidth = Math.max(this.opts.groupSeparatorWidth, 1 / this.dpr)
    this.strokeBoundary(this.separators.groupCols ?? [], 'cols', ncols)
    this.strokeBoundary(this.separators.groupRows ?? [], 'rows', nrows)
    ctx.restore()
  }

  /**
   * Block labels for one axis, or `[]` when the axis has more blocks than
   * `maxLabels`. The default is `MAX_CATEGORICAL_TICKS = 50`, the same
   * threshold `_level_axis`/`_bin_axis` use in `ops/show.py`: beyond it one
   * tick per contig degenerates into an unreadable smear.
   */
  labelBlocks(axis: 'rows' | 'cols'): LabelBlock[] {
    const n = axis === 'rows' ? this.dims().nrows : this.dims().ncols
    const blocks = separatorBlocks(this.separators[axis], n)
    return blocks.length > 0 && blocks.length <= this.opts.maxLabels ? blocks : []
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
      const centre = plot.x + this.colScale.toPixel((block.start + block.end) / 2)
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
      const centre = plot.y + this.rowScale.toPixel((block.start + block.end) / 2)
      if (centre < plot.y || centre > plot.y + plot.height) continue
      if (centre - last < LABEL_MIN_GAP) continue
      last = centre
      if (!rowsInMargin) ctx.strokeText(block.label, rowX, centre)
      ctx.fillText(block.label, rowX, centre)
    }
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
      const r = canvas.getBoundingClientRect()
      return [e.clientX - r.left, e.clientY - r.top]
    }

    const onDown = (e: MouseEvent): void => {
      this.dragging = true
      this.dragMoved = false
      const [x, y] = local(e)
      this.lastX = x
      this.lastY = y
      canvas.focus()
    }
    const onMove = (e: MouseEvent): void => {
      const [x, y] = local(e)
      if (this.dragging) {
        const dx = x - this.lastX
        const dy = y - this.lastY
        if (Math.abs(dx) + Math.abs(dy) > 2) this.dragMoved = true
        this.lastX = x
        this.lastY = y
        this.panBy(dx, dy)
        this.draw()
      } else if (this.onHover !== null) {
        this.onHover(this.cellAt(x, y), { x, y })
      }
    }
    const onUp = (e: MouseEvent): void => {
      if (this.dragging && !this.dragMoved && this.onCellClick !== null) {
        const [x, y] = local(e)
        const cell = this.cellAt(x, y)
        if (cell !== null) this.onCellClick(cell)
      }
      this.dragging = false
    }
    const onLeave = (): void => {
      this.dragging = false
      this.onHover?.(null)
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const [x, y] = local(e)
      // Exponential in the wheel delta so a trackpad's many small events and a
      // mouse wheel's few large ones compose to the same total zoom.
      this.zoomAt(x, y, Math.exp(-e.deltaY * 0.002))
      this.draw()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (this.handleKeyDown(e)) this.draw()
    }

    canvas.addEventListener('mousedown', onDown)
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mouseup', onUp)
    canvas.addEventListener('mouseleave', onLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('keydown', onKey)
    this.detachFns = [
      () => canvas.removeEventListener('mousedown', onDown),
      () => canvas.removeEventListener('mousemove', onMove),
      () => canvas.removeEventListener('mouseup', onUp),
      () => canvas.removeEventListener('mouseleave', onLeave),
      () => canvas.removeEventListener('wheel', onWheel),
      () => canvas.removeEventListener('keydown', onKey),
    ]
  }

  /** Remove every listener {@link attach} installed. Idempotent. */
  detach(): void {
    for (const fn of this.detachFns) fn()
    this.detachFns = []
  }
}

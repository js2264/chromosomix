/**
 * The colourbar.
 *
 * One rule shapes the whole module: **tick labels are in untransformed units**.
 * The bar is linear in *transformed* space, because that is what
 * `imshow(vmin=0, vmax=…)` normalises over, but a reader reads contact counts,
 * not `log1p` of contact counts. Labelling the bar `0, 2, 4, 6` would be
 * literally what matplotlib does and would tell nobody anything.
 *
 * The consequence is that ticks are *not* evenly spaced under a log transform.
 * That is the point: the uneven spacing is the transform, made visible.
 */

import type { ColorScale } from '../types'
import { COLORMAP_SIZE, applyColormap } from './colormaps'
import { inverseTransform, transformValue } from './scale'

/** One labelled tick on the bar. */
export interface ColorbarTick {
  /** Fraction along the bar, `0` at `vmin` and `1` at `vmax`. */
  position: number
  /** The untransformed value this tick marks. */
  value: number
  /** The rendered label, already formatted. */
  label: string
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

function threeSig(x: number): string {
  const a = Math.abs(x)
  return trimZeros(a >= 100 ? x.toFixed(0) : a >= 10 ? x.toFixed(1) : x.toFixed(2))
}

/**
 * Format a contact count for a tick label: plain below 10 000, then `k`/`M`/`G`
 * suffixes. Deterministic and locale-independent, so a screenshot in the paper
 * and a reader's browser produce the same string.
 */
export function formatCount(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a >= 1e12) return `${threeSig(v / 1e12)}T`
  if (a >= 1e9) return `${threeSig(v / 1e9)}G`
  if (a >= 1e6) return `${threeSig(v / 1e6)}M`
  if (a >= 1e4) return `${threeSig(v / 1e3)}k`
  if (a >= 1) return Number.isInteger(v) ? String(v) : threeSig(v)
  return trimZeros(v.toPrecision(2))
}

/** Round ticks for a linear axis: a 1, 2 or 5 step at the right magnitude. */
function niceLinearTicks(lo: number, hi: number, maxTicks: number): number[] {
  const raw = (hi - lo) / Math.max(1, maxTicks - 1)
  if (!(raw > 0)) return []
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v)
  return out
}

/**
 * Round ticks for a log axis: decades, subdivided 1-2-5 while that still fits
 * in `maxTicks`, thinned to every k-th decade when even bare decades overflow.
 *
 * `lo` is often 0 (the bottom of a `log1p` bar), which has no decade; the floor
 * is then four decades below `hi`, which is as much dynamic range as a small
 * bar can label legibly.
 */
function decadeTicks(lo: number, hi: number, maxTicks: number): number[] {
  if (!(hi > 0)) return []
  const bottom = lo > 0 ? lo : hi / 1e4
  const dlo = Math.floor(Math.log10(bottom))
  const dhi = Math.floor(Math.log10(hi))
  for (const mantissas of [
    [1, 2, 5],
    [1, 5],
    [1],
  ]) {
    const vals: number[] = []
    for (let d = dlo; d <= dhi; d++) {
      for (const m of mantissas) {
        const v = m * 10 ** d
        if (v >= bottom && v <= hi) vals.push(v)
      }
    }
    if (vals.length <= maxTicks) return vals
  }
  const decades: number[] = []
  for (let d = dlo; d <= dhi; d++) {
    const v = 10 ** d
    if (v >= bottom && v <= hi) decades.push(v)
  }
  const stride = Math.max(1, Math.ceil(decades.length / maxTicks))
  return decades.filter((_, i) => i % stride === 0)
}

/** Ticks closer than this fraction of the bar are dropped as illegible. */
const MIN_TICK_SPACING = 0.06

/**
 * Choose tick positions and labels for a resolved colour scale.
 *
 * The two endpoints are placed first and therefore win every collision: the
 * bottom of the bar and, more importantly, `vmax` — the saturation point, the
 * one number a reader needs in order to know what "black" means.
 *
 * Under `log10` with `vmin = 0` the bottom label is written `≤ 1`, because
 * {@link transformValues} clamped every count at or below 1 to the same
 * transformed 0 and the bar genuinely cannot distinguish them.
 *
 * @param scale A scale with finite `vmin`/`vmax` — i.e. `Raster.scale`, not the
 * requested scale, whose `vmax` may still be `NaN`.
 */
export function colorbarTicks(scale: ColorScale, maxTicks = 5): ColorbarTick[] {
  const vmin = Number.isFinite(scale.vmin) ? scale.vmin : 0
  const vmax = Number.isFinite(scale.vmax) ? scale.vmax : vmin + 1
  const lo = inverseTransform(vmin, scale.transform)
  const hi = inverseTransform(vmax, scale.transform)
  if (!(vmax > vmin)) return [{ position: 0, value: lo, label: formatCount(lo) }]

  const span = vmax - vmin
  const ticks: ColorbarTick[] = []
  const push = (value: number, label?: string): void => {
    const position = (transformValue(value, scale.transform) - vmin) / span
    if (position < -1e-9 || position > 1 + 1e-9) return
    const p = clamp(position, 0, 1)
    if (ticks.some((t) => Math.abs(t.position - p) < MIN_TICK_SPACING)) return
    ticks.push({ position: p, value, label: label ?? formatCount(value) })
  }

  const clamped = scale.transform === 'log10' && vmin <= 0
  push(lo, clamped ? `≤ ${formatCount(lo)}` : undefined)
  push(hi)
  const rounds =
    scale.transform === 'none'
      ? niceLinearTicks(lo, hi, maxTicks)
      : decadeTicks(lo, hi, maxTicks)
  for (const v of rounds) push(v)

  ticks.sort((a, b) => a.position - b.position)
  return ticks
}

// ---------------------------------------------------------------------------
// ColorbarView
// ---------------------------------------------------------------------------

export interface ColorbarOptions {
  /** `vertical` puts `vmin` at the bottom, as matplotlib's colorbar does. */
  orientation?: 'vertical' | 'horizontal'
  /** Thickness of the coloured strip, in CSS pixels. */
  barThickness?: number
  /** Caption drawn beside the bar. Units, not the transform. */
  caption?: string
  /** Also print the transform in small type, so a figure is self-describing. */
  showTransform?: boolean
  font?: string
  textColor?: string
  /** Outline around the strip. `null` to omit. */
  borderColor?: string | null
  tickLength?: number
  maxTicks?: number
  /** Override `devicePixelRatio`, mostly for tests. `0` means "detect". */
  devicePixelRatio?: number
}

type ResolvedColorbarOptions = Required<Omit<ColorbarOptions, 'borderColor'>> & {
  borderColor: string | null
}

function detectDpr(): number {
  const g = globalThis as { devicePixelRatio?: number }
  return typeof g.devicePixelRatio === 'number' && g.devicePixelRatio > 0
    ? g.devicePixelRatio
    : 1
}

/**
 * A small colourbar on its own canvas, drawn from the same 256-entry lookup
 * table as the heatmap so the two cannot drift.
 *
 * The strip is painted as 256 bands rather than a CSS gradient: a gradient
 * would interpolate in sRGB between the stops the browser chooses, which is not
 * what `applyColormap` returns for a perceptually non-linear map like `magma`.
 */
export class ColorbarView {
  private readonly canvas: HTMLCanvasElement
  /** Not `readonly`: {@link renderTo} borrows it for one draw, as the heatmap does. */
  private ctx: CanvasRenderingContext2D
  private readonly opts: ResolvedColorbarOptions
  private scale: ColorScale
  private cssWidth = 0
  private cssHeight = 0
  private dpr = 1

  constructor(canvas: HTMLCanvasElement, options: ColorbarOptions = {}) {
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('Could not acquire a 2d canvas context')
    this.canvas = canvas
    this.ctx = ctx
    this.opts = {
      orientation: options.orientation ?? 'vertical',
      barThickness: options.barThickness ?? 14,
      caption: options.caption ?? 'contacts',
      showTransform: options.showTransform ?? true,
      font: options.font ?? '10px system-ui, sans-serif',
      textColor: options.textColor ?? '#333333',
      borderColor: options.borderColor === undefined ? '#999999' : options.borderColor,
      tickLength: options.tickLength ?? 4,
      maxTicks: options.maxTicks ?? 5,
      devicePixelRatio: options.devicePixelRatio ?? 0,
    }
    this.scale = { vmin: 0, vmax: 1, transform: 'log1p', colormap: 'afmhot_r' }
    this.resize()
  }

  /**
   * Adopt a resolved colour scale — normally `HeatmapView.effectiveScale`, so
   * the bar always describes the image actually on screen.
   */
  setScale(scale: ColorScale): void {
    this.scale = { ...scale }
  }

  /** The ticks {@link draw} will render. Exposed for a DOM-based legend. */
  ticks(): ColorbarTick[] {
    return colorbarTicks(this.scale, this.opts.maxTicks)
  }

  /**
   * Turn the bar on its side.
   *
   * A legend beside a square plot is vertical; on a phone the plot is as wide
   * as the screen and the only room left is under it, where a vertical bar
   * would be a 5.5rem column of nothing. Same drawing code either way — this
   * picks which of the two branches in {@link draw} runs.
   */
  setOrientation(orientation: 'vertical' | 'horizontal'): void {
    this.opts.orientation = orientation
  }

  /** Draw into another context at `scale` device pixels per CSS pixel. */
  renderTo(ctx: CanvasRenderingContext2D, scale: number): void {
    const previousCtx = this.ctx
    const previousDpr = this.dpr
    this.ctx = ctx
    this.dpr = scale
    try {
      this.draw()
    } finally {
      this.ctx = previousCtx
      this.dpr = previousDpr
    }
  }

  /** The canvas size, in CSS pixels — what an export has to allocate. */
  get cssSize(): { width: number; height: number } {
    return { width: this.cssWidth, height: this.cssHeight }
  }

  /**
   * Re-read the canvas's CSS size, resize its backing store, and repaint.
   *
   * The repaint is not a convenience. Assigning `canvas.width` **clears** the
   * canvas, so a resize that did not redraw left the legend blank — and the
   * owner's redraw is guarded on the colour *scale* having changed, which a
   * resize does not change. Adding a track was enough to trigger it: the lanes
   * relayout the plot, the resize observer fires, the bar is cleared, the guard
   * says the scale is the same, and the legend simply disappears for as long as
   * the view lasts.
   *
   * So the invariant lives here, where it cannot be forgotten by a third
   * caller: a resize never leaves the bar empty. Guarded on the backing store
   * actually changing, because the observer fires on every layout pass and this
   * is 256 `fillRect`s and a tick layout.
   */
  resize(cssWidth?: number, cssHeight?: number): void {
    const w = cssWidth ?? this.canvas.clientWidth
    const h = cssHeight ?? this.canvas.clientHeight
    this.cssWidth = w > 0 ? w : this.canvas.width || 1
    this.cssHeight = h > 0 ? h : this.canvas.height || 1
    this.dpr = this.opts.devicePixelRatio > 0 ? this.opts.devicePixelRatio : detectDpr()
    const width = Math.max(1, Math.round(this.cssWidth * this.dpr))
    const height = Math.max(1, Math.round(this.cssHeight * this.dpr))
    if (this.canvas.width === width && this.canvas.height === height) return
    this.canvas.width = width
    this.canvas.height = height
    this.draw()
  }

  draw(): void {
    const ctx = this.ctx
    const o = this.opts
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight)
    ctx.font = o.font
    ctx.fillStyle = o.textColor

    const lut = applyColormap(this.scale.colormap)
    const ticks = this.ticks()
    const vertical = o.orientation === 'vertical'
    const captionHeight = o.caption.length > 0 ? 14 : 0

    if (vertical) {
      const x = 1
      const y = captionHeight + 4
      const w = o.barThickness
      const h = Math.max(1, this.cssHeight - y - 4)
      this.paintStrip(lut, x, y, w, h, true)
      if (o.borderColor !== null) {
        ctx.strokeStyle = o.borderColor
        ctx.lineWidth = 1 / this.dpr
        ctx.strokeRect(x + 0.5 / this.dpr, y + 0.5 / this.dpr, w, h)
      }
      ctx.fillStyle = o.textColor
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.strokeStyle = o.textColor
      ctx.lineWidth = 1 / this.dpr
      for (const tick of ticks) {
        // vmin at the bottom, matching matplotlib's vertical colorbar.
        const ty = y + h * (1 - tick.position)
        const snapped = (Math.round(ty * this.dpr - 0.5) + 0.5) / this.dpr
        ctx.beginPath()
        ctx.moveTo(x + w, snapped)
        ctx.lineTo(x + w + o.tickLength, snapped)
        ctx.stroke()
        ctx.fillText(tick.label, x + w + o.tickLength + 3, snapped)
      }
      if (captionHeight > 0) {
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillText(this.captionText(), 0, 1)
      }
      return
    }

    const x = 1
    const y = captionHeight + 4
    const w = Math.max(1, this.cssWidth - 2)
    const h = o.barThickness
    this.paintStrip(lut, x, y, w, h, false)
    if (o.borderColor !== null) {
      ctx.strokeStyle = o.borderColor
      ctx.lineWidth = 1 / this.dpr
      ctx.strokeRect(x + 0.5 / this.dpr, y + 0.5 / this.dpr, w, h)
    }
    ctx.fillStyle = o.textColor
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.strokeStyle = o.textColor
    ctx.lineWidth = 1 / this.dpr
    for (const tick of ticks) {
      const tx = x + w * tick.position
      const snapped = (Math.round(tx * this.dpr - 0.5) + 0.5) / this.dpr
      ctx.beginPath()
      ctx.moveTo(snapped, y + h)
      ctx.lineTo(snapped, y + h + o.tickLength)
      ctx.stroke()
      // The mark stays on its value; the label steps back inside the canvas
      // when it would hang off the end. The two extremes are `vmin` and `vmax`
      // — the numbers a reader most wants — and half of "≤ 0.00085" is not one.
      const half = ctx.measureText(tick.label).width / 2
      const at = Math.min(Math.max(snapped, x + half), x + w - half)
      ctx.fillText(tick.label, at, y + h + o.tickLength + 2)
    }
    if (captionHeight > 0) {
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(this.captionText(), 0, 1)
    }
  }

  private captionText(): string {
    const o = this.opts
    // A balanced cell is `raw * w[i] * w[j]` — a fraction, not a count, and
    // routinely 0.0009 where the caption said "count". Naming it here is the
    // only place the reader is told which of the two the numbers beside the
    // strip are.
    const units = this.scale.balanced === true ? 'balanced' : o.caption
    if (!o.showTransform || this.scale.transform === 'none') return units
    return `${units} (${this.scale.transform})`
  }

  /**
   * Paint the 256 colour bands. Each band is drawn one pixel oversized along
   * the bar so rounding cannot leave a hairline of background between them.
   */
  private paintStrip(
    lut: Uint8ClampedArray,
    x: number,
    y: number,
    w: number,
    h: number,
    vertical: boolean
  ): void {
    const ctx = this.ctx
    const length = vertical ? h : w
    for (let i = 0; i < COLORMAP_SIZE; i++) {
      const s = i * 4
      ctx.fillStyle = `rgb(${lut[s]}, ${lut[s + 1]}, ${lut[s + 2]})`
      const a = (length * i) / COLORMAP_SIZE
      const b = (length * (i + 1)) / COLORMAP_SIZE
      if (vertical) {
        // i = 0 is vmin, which belongs at the bottom.
        ctx.fillRect(x, y + h - b, w, b - a + 1 / this.dpr)
      } else {
        ctx.fillRect(x + a, y, b - a + 1 / this.dpr, h)
      }
    }
  }
}

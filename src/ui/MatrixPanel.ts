/**
 * The heatmap panel: canvas, colourbar, colour controls, hover readout.
 *
 * Shared by the genome, pair, region and overview views so that all four have
 * the same defaults, the same keys and the same readout. Two properties matter
 * enough to state:
 *
 * 1. **Pan and zoom perform zero I/O.** The whole block is already in memory
 *    (spec §2), so every interaction here is a canvas transform over data that
 *    has already arrived. Nothing in this file holds a reference to the worker
 *    client, which makes that structural rather than a promise.
 * 2. **The scale rule is `metacooler show`'s** (§7.1) — `log1p`, `vmin = 0`,
 *    `vmax` at the 99th percentile of the non-zero *transformed* values,
 *    recomputed on every view change, with a manual override. `vmax: NaN` is
 *    how {@link HeatmapView} is asked for that default, so the number the CLI
 *    computes and the number drawn here come from one implementation. The
 *    *colormap* the panel opens with is the viewer's own ramp rather than the
 *    CLI's `afmhot_r`, which the picker still offers unchanged
 *    ({@link DEFAULT_UI_COLORMAP}).
 *
 * Interaction — drag, wheel, click, and the §7.2 keyboard pan and zoom — is
 * `HeatmapView.attach()`'s, not this panel's: the view owns the transform, so
 * it is the only thing that can move it coherently.
 */

import { MAX_CATEGORICAL_TICKS } from '../constants'
import { ColorbarView, formatCount } from '../render/colorbar'
import {
  COLORMAP_NAMES,
  COLOR_VISION_SAFE_COLORMAPS,
  DEFAULT_UI_COLORMAP,
} from '../render/colormaps'
import {
  HeatmapView,
  type AxisCoords,
  type Cell,
  type PlotOptions,
  type SeparatorSet,
} from '../render/heatmap'
import { inverseTransform } from '../render/scale'
import type { ColorScale, DenseMatrix, Separator, Transform } from '../types'
import type { AxisGroup, MatrixResult } from '../worker/protocol'
import { ClipRange } from './ClipRange'
import { button, el, field, fmt } from './dom'
import {
  CSS_DPI,
  EXPORT_DPI_CHOICES,
  canvasToPdf,
  canvasToPng,
  downloadBlob,
  exportBaseName,
  scaleForDpi,
} from './export'
import { setReadout } from './readout'
import {
  PLOT_OPTION_LABELS,
  getPlotOptions,
  setPlotOption,
  subscribePlotOptions,
  type PlotOptionKey,
} from './plotOptions'

const TRANSFORMS: Transform[] = ['log1p', 'log10', 'none']

export interface MatrixPanelOptions {
  /** Bin size in bp, for the coordinate readout. */
  binsize: number
  /** Offered aggregation levels; omit for views with no level toggle. */
  levels?: Array<'bin' | 'contig'>
  initial?: {
    transform?: Transform
    colormap?: string
    vmin?: number
    vmax?: number
    level?: 'bin' | 'contig'
  }
  /** Whether counts are currently multiplied by their bin weights (§6.4). */
  balance?: boolean
  /** Offer the balance control at all — only files with a weight column do. */
  offerBalance?: boolean
  onScaleChange?(scale: {
    transform: Transform
    colormap: string
    vmin?: number
    vmax?: number
  }): void
  onLevelChange?(level: 'bin' | 'contig'): void
  onBalanceChange?(balance: boolean): void
  /** A cell was clicked; offsets are block-local, ids are absolute. */
  onCellClick?(cell: Cell, groups: { row?: AxisGroup; col?: AxisGroup }): void
  /**
   * Keep the colour controls out of the panel so the owning view can place them
   * elsewhere — the genome and region views stack them in their sidebar, above
   * the contig list. The panel still owns them; only their mount point moves.
   */
  detachedControls?: boolean
  /**
   * Suppress the panel's own title line.
   *
   * Every view already names what it is showing in its `<h2>`, so the panel
   * title repeated it one line lower ("metator_00001_00000" then
   * "metator_00001_00000 — contig level"). The level is in the controls; the
   * name is in the heading; the line said nothing either did not.
   */
  hideTitle?: boolean
}

export class MatrixPanel {
  readonly el: HTMLElement
  /**
   * The colour controls, as a self-contained card. Always built; mounted inside
   * {@link el} unless `detachedControls` was set, in which case the owning view
   * places it. Wired either way — the panel keeps the listeners.
   */
  readonly controlsEl: HTMLElement
  /**
   * The plot card: overlays, the fit control and the export.
   *
   * Separate from the colour card because the two answer different questions —
   * one is *what the numbers look like*, the other *what the figure does* — and
   * because every view mounts this one identically, which is the whole of "the
   * same plotting options everywhere".
   */
  readonly plotEl: HTMLElement

  private readonly canvas: HTMLCanvasElement
  private readonly barCanvas: HTMLCanvasElement
  private readonly heatmap: HeatmapView
  private readonly colorbar: ColorbarView
  private readonly tooltip: HTMLElement
  private readonly titleNode: HTMLElement
  private readonly clip: ClipRange
  private readonly overlay: HTMLElement
  private readonly optionButtons = new Map<PlotOptionKey, HTMLElement>()
  private readonly unsubscribePlotOptions: () => void
  private readonly themeWatchers: () => void
  private readonly observer: ResizeObserver | null
  private readonly exportStatus: HTMLElement
  private exportDpi = 300
  /** What the figure is called, for the download name. */
  private exportName = 'contact-map'

  private data: MatrixResult | null = null
  private transform: Transform
  private colormap: string
  private manualVmin: number | undefined
  private manualVmax: number | undefined
  private level: 'bin' | 'contig'
  private frame = 0

  constructor(private readonly options: MatrixPanelOptions) {
    this.transform = options.initial?.transform ?? 'log1p'
    this.colormap = options.initial?.colormap ?? DEFAULT_UI_COLORMAP
    this.manualVmin = options.initial?.vmin
    this.manualVmax = options.initial?.vmax
    this.level = options.initial?.level ?? 'bin'

    this.canvas = el('canvas', { class: 'heatmap-canvas' })
    this.barCanvas = el('canvas', { class: 'colorbar-canvas' })
    // A tooltip follows the pointer with the same three facts as the readout.
    // Both exist on purpose: the tooltip answers "what is under my cursor"
    // without a glance away from the matrix, and the readout keeps the last
    // answer visible after the pointer has moved on.
    this.tooltip = el('div', { class: 'cell-tip hidden' })
    this.titleNode = el('h2', { class: 'panel-title', text: '' })
    this.overlay = el('div', { class: 'panel-overlay hidden' })

    this.heatmap = new HeatmapView(this.canvas, {
      plotOptions: getPlotOptions(),
      ...readCanvasPalette(),
      // Contig labels are drawn only below the Python threshold; above it they
      // would be a grey smear rather than information (`ops/show.py`).
      maxLabels: MAX_CATEGORICAL_TICKS,
      // Gutters are measured from the labels themselves: real contig names run
      // to `NODE_7431_len_134871`, which no fixed margin fits, and a genome with
      // too many contigs to label should not reserve a gutter at all.
      autoMargin: true,
      onChange: () => this.schedule(),
      onHover: (cell, event) => this.describe(cell, event),
      onCellClick: (cell) => this.emitClick(cell),
    })
    this.heatmap.attach()
    this.colorbar = new ColorbarView(this.barCanvas, { caption: 'count' })

    const transformSelect = el('select', { class: 'select' })
    for (const name of TRANSFORMS) transformSelect.appendChild(el('option', { value: name, text: name }))
    transformSelect.value = this.transform
    transformSelect.addEventListener('change', () => {
      this.transform = transformSelect.value as Transform
      // A clip is a pair of numbers in transformed units, so it does not survive
      // a change of transform: `vmax = 8` is a sensible ceiling under `log1p`
      // and a black image under `none`. Back to auto, which is right for both.
      this.manualVmin = undefined
      this.manualVmax = undefined
      this.rescale()
    })

    const colormapSelect = el('select', { class: 'select' })
    for (const name of COLORMAP_NAMES) {
      const safe = COLOR_VISION_SAFE_COLORMAPS.includes(name)
      colormapSelect.appendChild(el('option', { value: name, text: safe ? `${name} ✓` : name }))
    }
    colormapSelect.value = this.colormap
    colormapSelect.title = 'A ✓ marks a colour-vision-safe map.'
    colormapSelect.addEventListener('change', () => {
      this.colormap = colormapSelect.value
      this.rescale()
    })

    this.clip = new ClipRange({
      onChange: (clip) => {
        this.manualVmin = clip?.vmin
        this.manualVmax = clip?.vmax
        this.rescale()
      },
      // The boxes are in transformed units; the caption says what those are in
      // the units the colourbar and the tooltip use.
      format: (value) => formatCount(inverseTransform(value, this.transform)),
    })

    const controls: HTMLElement[] = [
      field('transform', transformSelect, 'Value transform, matching `metacooler show --transform`.'),
      field('colormap', colormapSelect, '`afmhot_r` is what `metacooler show` draws (§7.1).'),
      // Not `field()`: that wraps its control in a `<label>`, and a label around
      // four inputs and a button focuses whichever one it feels like.
      el(
        'div',
        {
          class: 'field field-clip',
          title:
            'Where the colourmap starts and saturates, in transformed units. ' +
            'Auto is the §7.1 default: 0 to the 99th percentile of the values in view.',
        },
        el('span', { class: 'field-label', text: 'clip' }),
        this.clip.el,
      ),
    ]

    /**
     * One overlay toggle. It *writes* to the shared store and *reads* from the
     * subscription below, so a toggle flipped from the command palette lights
     * the same button up — the button never holds the state itself.
     */
    const optionToggle = (key: PlotOptionKey): HTMLElement => {
      const { label, hint } = PLOT_OPTION_LABELS[key]
      const node = el('button', { class: 'btn btn-toggle', type: 'button', text: label, title: hint })
      node.addEventListener('click', () => setPlotOption(key, !getPlotOptions()[key]))
      this.optionButtons.set(key, node)
      return node
    }

    const dpiSelect = el('select', { class: 'select' })
    for (const dpi of EXPORT_DPI_CHOICES) {
      dpiSelect.appendChild(
        el('option', { value: String(dpi), text: dpi === CSS_DPI ? `${dpi} (screen)` : `${dpi}` }),
      )
    }
    dpiSelect.value = String(this.exportDpi)
    dpiSelect.addEventListener('change', () => {
      this.exportDpi = Number(dpiSelect.value)
    })
    this.exportStatus = el('span', { class: 'clip-note export-note' })

    this.plotEl = el(
      'div',
      { class: 'controls-card' },
      el('h3', { class: 'controls-title', text: 'Plot' }),
      el(
        'div',
        { class: 'panel-controls' },
        el(
          'div',
          { class: 'field field-block' },
          el('span', { class: 'field-label', text: 'overlays' }),
          el(
            'div',
            { class: 'plot-option-row' },
            optionToggle('crosshair'),
            optionToggle('dividers'),
            optionToggle('labels'),
            optionToggle('ticks'),
          ),
        ),
        button('fit to view', () => this.fit(), {
          class: 'btn btn-wide',
          title: 'Undo every pan and zoom (key: 0, or a double click on the plot)',
        }),
        field('export at', dpiSelect, 'Dots per inch of the saved image. 96 is what is on screen.'),
        el(
          'div',
          { class: 'field field-block' },
          el('span', { class: 'field-label', text: 'save as' }),
          el(
            'div',
            { class: 'plot-option-row' },
            button('PNG', () => void this.save('png'), { class: 'btn', title: 'Save the figure as a PNG' }),
            button('PDF', () => void this.save('pdf'), {
              class: 'btn',
              title: 'Save the figure as a one-page PDF, at the same resolution',
            }),
          ),
        ),
        this.exportStatus,
      ),
    )
    this.paintPlotOptions(getPlotOptions())
    this.unsubscribePlotOptions = subscribePlotOptions((options) => {
      this.heatmap.setPlotOptions(options)
      this.paintPlotOptions(options)
    })

    if (options.offerBalance === true) {
      const balance = el('input', { class: 'checkbox', type: 'checkbox' })
      balance.checked = options.balance === true
      // No transform is forced here any more. Balanced values are fractions, so
      // `log10` of them is negative throughout, which the auto rule used to
      // answer with `[0, 1]` — a blank panel — and this control used to dodge by
      // switching the transform to `log1p` behind the user's back. Both the rule
      // and `log10`'s treatment of zero now handle a sub-unit matrix, so the
      // transform is the user's choice again (`render/scale.ts`).
      balance.addEventListener('change', () => options.onBalanceChange?.(balance.checked))
      controls.unshift(
        field(
          'balanced',
          balance,
          'Multiply each cell by its two bin weights — cooler`s balanced matrix. ' +
            'Bins the balancer dropped have no weight and show as blank.',
        ),
      )
    }

    if (options.levels && options.levels.length > 1) {
      const levelSelect = el('select', { class: 'select' })
      for (const name of options.levels) levelSelect.appendChild(el('option', { value: name, text: name }))
      levelSelect.value = this.level
      levelSelect.addEventListener('change', () => {
        this.level = levelSelect.value as 'bin' | 'contig'
        options.onLevelChange?.(this.level)
      })
      controls.unshift(field('level', levelSelect, 'Summed from the loaded matrix — no further reads.'))
    }

    this.controlsEl = el(
      'div',
      { class: 'controls-card' },
      el('h3', { class: 'controls-title', text: 'View' }),
      el('div', { class: 'panel-controls' }, ...controls),
    )

    const wrap = el('div', { class: 'heatmap-wrap' }, this.canvas, this.overlay, this.tooltip)

    // The colourbar sits immediately right of the plot and is deliberately
    // short: it is a legend, and a legend as tall as the figure reads as a
    // second panel competing with it.
    const body = el(
      'div',
      { class: 'panel-body' },
      wrap,
      el('div', { class: 'colorbar-slot' }, this.barCanvas),
    )

    this.el = el(
      'section',
      { class: 'panel' },
      ...(options.hideTitle === true && options.detachedControls === true
        ? []
        : [
            el(
              'header',
              { class: 'panel-head' },
              ...(options.hideTitle === true ? [] : [this.titleNode]),
              ...(options.detachedControls === true ? [] : [this.controlsEl, this.plotEl]),
            ),
          ]),
      body,
    )

    // Labels and the plot frame are page furniture, so they follow the theme.
    // The canvas cannot read a CSS variable, and the values are only correct
    // for the theme that was in force when they were read — hence a watcher on
    // both the explicit override and the system preference.
    this.themeWatchers = watchTheme(() => {
      this.heatmap.setPalette(readCanvasPalette())
      this.schedule()
    })

    this.observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            this.heatmap.resize()
            this.colorbar.resize()
            this.schedule()
          })
    this.observer?.observe(wrap)
    // The canvas has no size until it is in the document; size it once laid out.
    requestAnimationFrame(() => {
      this.heatmap.resize()
      this.colorbar.resize()
      this.schedule()
    })
  }

  /** Reflect the shared overlay state on the buttons. */
  private paintPlotOptions(options: PlotOptions): void {
    for (const [key, node] of this.optionButtons) {
      node.setAttribute('aria-pressed', String(options[key]))
    }
  }

  /** Release the resize observer, the canvas listeners and the subscription. */
  destroy(): void {
    setReadout('')
    this.unsubscribePlotOptions()
    this.themeWatchers()
    this.observer?.disconnect()
    this.heatmap.detach()
    if (this.frame !== 0) cancelAnimationFrame(this.frame)
  }

  /** Refit the block to the canvas, undoing every pan and zoom. */
  fit(): void {
    this.heatmap.fit()
    this.schedule()
  }

  /**
   * The figure as one canvas: the plot with its legend beside it, on an opaque
   * page background, at `dpi` dots per inch.
   *
   * Composed from the two live views rather than copied off the screen — each
   * redraws itself into this canvas at the export scale, so the labels, the
   * hairlines and the tick marks are drawn at that resolution instead of being
   * enlarged. What is *framed* is whatever is framed on screen, pan and zoom
   * included.
   */
  exportCanvas(dpi: number): HTMLCanvasElement {
    const scale = scaleForDpi(dpi)
    const plot = this.heatmap.cssSize
    const bar = this.colorbar.cssSize
    const gap = 10
    const width = plot.width + gap + bar.width
    const height = Math.max(plot.height, bar.height)

    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(width * scale))
    out.height = Math.max(1, Math.round(height * scale))
    const ctx = out.getContext('2d')
    if (ctx === null) throw new Error('Could not acquire a 2d context for the export canvas.')

    // The plot draws from the canvas origin and clears as it goes, so it goes
    // first and the background goes on underneath at the end.
    this.heatmap.renderTo(ctx, scale)

    // The legend renders into a canvas of its own and is then placed, because
    // `renderTo` also draws from the origin — there is nowhere to pass an
    // offset, and giving it one would be a second coordinate system for the
    // benefit of this one caller.
    const barCanvas = document.createElement('canvas')
    barCanvas.width = Math.max(1, Math.round(bar.width * scale))
    barCanvas.height = Math.max(1, Math.round(bar.height * scale))
    const barCtx = barCanvas.getContext('2d')
    if (barCtx !== null) this.colorbar.renderTo(barCtx, scale)
    // In device pixels: `renderTo` leaves the heatmap's own scale on the
    // context, and drawing the legend through that would put it at 3× its
    // offset, which is off the canvas entirely.
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(barCanvas, Math.round((plot.width + gap) * scale), 0)

    // Opaque, and in the theme on screen. A transparent PNG of a white-on-white
    // contact map is a blank rectangle in every viewer that composites onto
    // black, and the labels are drawn in the page's own text colour. Painted
    // *behind* what is already there — `#ffffff` first, so an unreadable
    // custom property leaves a white page rather than a black one.
    ctx.globalCompositeOperation = 'destination-over'
    ctx.fillStyle = '#ffffff'
    ctx.fillStyle = readPageBackground()
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.globalCompositeOperation = 'source-over'
    return out
  }

  /** Save the figure. The status line under the buttons reports what happened. */
  private async save(format: 'png' | 'pdf'): Promise<void> {
    const name = `${exportBaseName(this.exportName)}-${this.exportDpi}dpi.${format}`
    this.exportStatus.textContent = `saving ${name}…`
    try {
      const canvas = this.exportCanvas(this.exportDpi)
      const blob =
        format === 'png'
          ? await canvasToPng(canvas)
          : await canvasToPdf(canvas, { dpi: this.exportDpi, title: this.exportName })
      downloadBlob(blob, name)
      this.exportStatus.textContent = `${name} · ${fmt.bytes(blob.size)}`
    } catch (err) {
      // Nothing here is worth an error screen: the view is intact and the user
      // can try a smaller size. Say what failed and stay put.
      this.exportStatus.textContent =
        err instanceof Error ? `export failed: ${err.message}` : 'export failed'
    }
  }

  /** Load a block. `HeatmapView` refits and recomputes the auto range (§7.1). */
  setData(data: MatrixResult, title: string): void {
    this.data = data
    this.exportName = title === '' ? this.exportName : title
    this.titleNode.textContent = title
    this.heatmap.setMatrix(toDense(data), separatorsFor(data))
    this.heatmap.setAxisCoords({
      rows: axisCoordsFor(data.rowGroups, data.rowExtent, data.level, this.options.binsize),
      cols: axisCoordsFor(data.colGroups, data.colExtent, data.level, this.options.binsize),
    })
    this.heatmap.setScale(this.scale())
    this.setBusy(false)
    this.schedule()
  }

  /** Show or hide the "loading" veil; the canvas keeps its last picture. */
  setBusy(busy: boolean, message = 'loading…'): void {
    this.overlay.textContent = message
    this.overlay.classList.toggle('hidden', !busy)
  }

  /**
   * The colour scale as configured. An unclipped bound is `NaN`, which is how
   * {@link HeatmapView} is asked for the `metacooler show` default.
   */
  scale(): ColorScale {
    return {
      vmin: this.manualVmin ?? Number.NaN,
      vmax: this.manualVmax ?? Number.NaN,
      transform: this.transform,
      colormap: this.colormap,
      balanced: this.options.balance === true,
    }
  }

  private rescale(): void {
    this.heatmap.setScale(this.scale())
    this.options.onScaleChange?.({
      transform: this.transform,
      colormap: this.colormap,
      vmin: this.manualVmin,
      vmax: this.manualVmax,
    })
    this.schedule()
  }

  /** Coalesce redraws to one per animation frame — the §12 60 fps budget. */
  private schedule(): void {
    if (this.frame !== 0) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.heatmap.draw()
      // After the draw, because this reads a number the rasteriser resolved.
      // `effectiveScale` is the scale the raster actually used, so this is where
      // the auto rule's numbers become visible — in the colourbar and, equally,
      // in the clip boxes, which is what a reader nudges rather than invents.
      const effective = this.heatmap.effectiveScale
      this.colorbar.setScale(effective)
      this.colorbar.draw()
      if (Number.isFinite(effective.vmin) && Number.isFinite(effective.vmax)) {
        this.clip.setValues(
          { vmin: effective.vmin, vmax: effective.vmax },
          this.manualVmin === undefined && this.manualVmax === undefined,
        )
      }
    })
  }

  private emitClick(cell: Cell): void {
    if (this.data === null) return
    this.options.onCellClick?.(cell, {
      row: groupAt(this.data.rowGroups, cell.row),
      col: groupAt(this.data.colGroups, cell.col),
    })
  }

  private describe(cell: Cell | null, at?: { x: number; y: number }): void {
    if (cell === null || this.data === null) {
      setReadout('')
      this.tooltip.classList.add('hidden')
      return
    }
    const data = this.data
    const rowGroup = groupAt(data.rowGroups, cell.row)
    const colGroup = groupAt(data.colGroups, cell.col)
    // Positions are measured in absolute bin space, so each axis needs the bin
    // its own block starts at — they differ on a rectangular two-contig block.
    const rowStart = data.rowExtent[0]
    const colStart = data.colExtent[0]
    const rowLabel = describeAxis(rowGroup, cell.row, data.level, this.options.binsize, rowStart)
    const colLabel = describeAxis(colGroup, cell.col, data.level, this.options.binsize, colStart)
    const count = Number.isNaN(cell.value) ? 'NaN (unbalanced)' : fmt.num(cell.value)

    setReadout(`${rowLabel}  ×  ${colLabel}   count ${count}`)

    // The names in full, unabbreviated, and each name written *once*: the axis
    // labels are elided when the blocks are narrow, so the tooltip is often the
    // only place the pair is spelled out — but on the diagonal of a contig map
    // the old layout printed `NODE_8524_len_441121` four times, and the number
    // the pointer is actually asking about was the last thing on the card.
    const sameBlock = rowGroup !== undefined && colGroup !== undefined && rowGroup.label === colGroup.label
    const heading = sameBlock
      ? [el('span', { class: 'cell-tip-name', text: rowGroup.label })]
      : [
          el('span', { class: 'cell-tip-name', text: rowGroup?.label ?? '—' }),
          el('span', { class: 'cell-tip-x', text: '×' }),
          el('span', { class: 'cell-tip-name', text: colGroup?.label ?? '—' }),
        ]
    const rowPos = positionIn(rowGroup, cell.row, data.level, this.options.binsize, rowStart)
    const colPos = positionIn(colGroup, cell.col, data.level, this.options.binsize, colStart)
    this.tooltip.replaceChildren(
      el('div', { class: 'cell-tip-pair' }, ...heading),
      ...(rowPos === null || colPos === null
        ? []
        : [el('div', { class: 'cell-tip-pos', text: `${rowPos}  ×  ${colPos}` })]),
      el('div', { class: 'cell-tip-count', text: `count ${count}` }),
    )
    this.tooltip.classList.remove('hidden')
    if (at !== undefined) this.placeTooltip(at.x, at.y)
  }

  /**
   * Keep the tooltip inside the panel.
   *
   * Offset from the pointer so it never sits under it, and flipped to the other
   * side near an edge — a tooltip clipped by the panel border is worse than no
   * tooltip, because it looks like the value is missing.
   */
  private placeTooltip(x: number, y: number): void {
    const host = this.tooltip.parentElement
    if (host === null) return
    const pad = 14
    const tipWidth = this.tooltip.offsetWidth
    const tipHeight = this.tooltip.offsetHeight
    const left = x + pad + tipWidth > host.clientWidth ? x - pad - tipWidth : x + pad
    const top = y + pad + tipHeight > host.clientHeight ? y - pad - tipHeight : y + pad
    this.tooltip.style.left = `${Math.max(0, left)}px`
    this.tooltip.style.top = `${Math.max(0, top)}px`
  }
}

/** Which group covers a block-local offset. */
export function groupAt(groups: AxisGroup[], offset: number): AxisGroup | undefined {
  let lo = 0
  let hi = groups.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const group = groups[mid]
    if (offset < group.start) hi = mid - 1
    else if (offset >= group.end) lo = mid + 1
    else return group
  }
  return undefined
}

/**
 * Base pairs from the start of the **contig** to the start of a cell.
 *
 * `group.start` is block-local, so `(offset - group.start) * binsize` measures
 * from the left edge of the picture rather than from the contig — the same
 * number only when the block begins on a contig boundary. A region view of
 * `contig:139005-199005` begins at bin 139, and the readout used to call that
 * cell 0 bp when it is 139 kb into the contig. `unitStart` is where the contig
 * itself begins, so the absolute bin `blockStart + offset` resolves correctly
 * (§3.3 arithmetic throughout; `/bins` is never consulted).
 */
export function bpWithin(
  group: AxisGroup,
  offset: number,
  blockStart: number,
  binsize: number,
): number {
  const first = group.unitStart ?? blockStart + group.start
  return (blockStart + offset - first) * binsize
}

/**
 * What one axis measures in base pairs, or `null` when it measures nothing a
 * position could be expressed in.
 *
 * Both refusals are the ones `_bin_axis` makes in `ops/show.py`. Above bin
 * level a cell *is* a contig or a genome, so a position inside one would be an
 * invention. Across more than one contig there is no single coordinate system:
 * the ticks are the contig names there, and they already are.
 *
 * The line itself is {@link bpWithin} at offset 0, from the same `unitStart`,
 * so a tick and the readout under the pointer cannot disagree.
 */
export function axisCoordsFor(
  groups: AxisGroup[],
  extent: readonly [number, number],
  level: 'bin' | 'contig' | 'genome',
  binsize: number,
): AxisCoords | null {
  if (level !== 'bin' || groups.length !== 1 || !(binsize > 0)) return null
  const group = groups[0]
  const first = group.unitStart ?? extent[0] + group.start
  return { bpPerCell: binsize, bpAtOrigin: (extent[0] - first) * binsize }
}

/**
 * One side of the hover readout. At bin level the position inside the contig is
 * exact arithmetic from the bin size (§3.3) — `/bins` is never consulted.
 */
function describeAxis(
  group: AxisGroup | undefined,
  offset: number,
  level: 'bin' | 'contig' | 'genome',
  binsize: number,
  blockStart: number,
): string {
  if (group === undefined) return '—'
  if (level !== 'bin') return group.label
  return `${group.label}:${fmt.bp(bpWithin(group, offset, blockStart, binsize))}`
}

/**
 * The offset inside a block, without its name — the tooltip's second line.
 *
 * `null` above bin level, where a cell *is* the block and a position inside it
 * would be an invention.
 */
function positionIn(
  group: AxisGroup | undefined,
  offset: number,
  level: 'bin' | 'contig' | 'genome',
  binsize: number,
  blockStart: number,
): string | null {
  if (group === undefined || level !== 'bin') return null
  return fmt.bp(bpWithin(group, offset, blockStart, binsize))
}

/**
 * The colours the canvas borrows from the stylesheet.
 *
 * Only three: the labels, their halo, and the plot frame. The separator and
 * crosshair colours are `ops/show.py`'s and stay fixed, so a screenshot from
 * the browser and a figure from the CLI remain the same image.
 */
function readCanvasPalette(): {
  labelColor: string
  labelHaloColor: string
  plotBorderColor: string
} {
  const style = getComputedStyle(document.documentElement)
  const pick = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }
  return {
    labelColor: pick('--text-dim', '#5b6169'),
    labelHaloColor: pick('--bg', '#ffffff'),
    plotBorderColor: pick('--border-strong', '#b9bec5'),
  }
}

/** The page colour an export is flattened onto — the theme in force. */
function readPageBackground(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  return value === '' ? '#ffffff' : value
}

/**
 * Call `onChange` whenever the effective theme changes: either the explicit
 * `data-theme` override or, in its absence, the system preference. Returns the
 * teardown.
 */
function watchTheme(onChange: () => void): () => void {
  const media = window.matchMedia?.('(prefers-color-scheme: dark)')
  const observer =
    typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => onChange())
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const listener = (): void => onChange()
  media?.addEventListener?.('change', listener)
  return () => {
    observer?.disconnect()
    media?.removeEventListener?.('change', listener)
  }
}

/**
 * Separator positions: the first row/column of every group after the first.
 *
 * A super-group set, when the reader supplies one, becomes the *group*
 * separators — the heavier line — so a contig × contig overview shows its
 * genome boundaries over its contig ones.
 */
export function separatorsFor(data: MatrixResult): SeparatorSet {
  const toSeparators = (groups: AxisGroup[]): Separator[] =>
    groups.map((group) => ({ at: group.start, label: group.label }))
  const set: SeparatorSet = {
    rows: toSeparators(data.rowGroups),
    cols: toSeparators(data.colGroups),
  }
  if (data.rowSuperGroups !== undefined) set.groupRows = toSeparators(data.rowSuperGroups)
  if (data.colSuperGroups !== undefined) set.groupCols = toSeparators(data.colSuperGroups)
  return set
}

/** Adapt a worker result to the renderer's {@link DenseMatrix}. */
export function toDense(data: MatrixResult): DenseMatrix {
  return {
    nrows: data.nrows,
    ncols: data.ncols,
    values: data.values,
    rowExtent: data.rowExtent,
    colExtent: data.colExtent,
  }
}

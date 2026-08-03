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

import { LABEL_MIN_SPAN_BP, MAX_CATEGORICAL_TICKS } from '../constants'
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
  type SelectionBox,
  type SeparatorSet,
} from '../render/heatmap'
import { rasterStride } from '../render/heatmap'
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
  captionStamp,
  downloadBlob,
  exportBaseName,
  fileStamp,
  largestDpiThatFits,
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

/**
 * What a dragged box resolves to: one block, and how much of it.
 *
 * *One* block, not the rectangle the box covers, because that is the view a
 * selection is asking for. A square drawn across the corner of two chromosomes
 * on a whole-genome map is asking to look at a chromosome — it cannot be asking
 * for a region that spans two of them, since no such region exists — so it
 * resolves to the one the drag began in, ending at the edge of the box or at
 * the end of that chromosome, whichever comes first.
 *
 * `range` is absent above bin level, where a cell *is* a contig or a genome and
 * there is no position inside one to name.
 */
export interface SelectedAxis {
  /** The block this axis of the box falls in: a contig, or a genome. */
  label: string
  /** Base pairs within that block, clamped to it; absent above bin level. */
  range?: [number, number]
}

export interface SelectedRegion {
  rows: SelectedAxis
  cols: SelectedAxis
  /**
   * `true` when the box lies *on* the diagonal: the same block on both axes,
   * covering the same stretch of it.
   *
   * Not "the same block" — that was the first version of this and it is the
   * wrong question. A box in the top-right corner of one chromosome is two
   * different windows of the same sequence, and answering it with the row's
   * window alone hands back a square centred on the diagonal: the one place the
   * reader was deliberately not looking. Only when both windows coincide is
   * there a single region to open.
   */
  diagonal: boolean
  level: 'bin' | 'contig' | 'genome'
  /** The cell the drag began on, for a view that resolves blocks its own way. */
  anchor: Cell
}

export interface MatrixPanelOptions {
  /** Bin size in bp, for the coordinate readout. */
  binsize: number
  /** Offered aggregation levels; omit for views with no level toggle. */
  levels?: Array<'bin' | 'contig'>
  /**
   * What to *call* each level, where the file's vocabulary differs from the
   * internal name. A cooler's sequences are chromosomes, and a control offering
   * "contig" on one is the app speaking about a file in words the file does not
   * use.
   */
  levelLabels?: Partial<Record<'bin' | 'contig', string>>
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
   * What the exported figure is a picture *of*, for its caption.
   *
   * The panel knows the bin size, the transform and the level; it does not know
   * which file or which genome, because it is mounted by five different views
   * over the same data. The router does, and passes it down.
   */
  caption?: { file: string; genome?: string }
  /**
   * An axis label was clicked. `name` is the block's own name — a genome in the
   * whole-metagenome overview, a contig everywhere else — and the view opens
   * whatever that name is.
   */
  onLabelClick?(axis: 'rows' | 'cols', name: string): void
  /**
   * A box was selected. The panel resolves it to *one* block and, at bin level,
   * to a base-pair range inside it; the view decides what opening that means.
   */
  onSelectRegion?(selection: SelectedRegion): void
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
  private readonly transformSelect: HTMLSelectElement
  private readonly colormapSelect: HTMLSelectElement
  private readonly overlay: HTMLElement
  private readonly optionButtons = new Map<PlotOptionKey, HTMLElement>()
  private readonly unsubscribePlotOptions: () => void
  private readonly themeWatchers: () => void
  private readonly narrowWatcher: () => void
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
  /** The scale the colourbar was last drawn for; `null` until it has been. */
  private painted: ColorScale | null = null
  /** The tooltip's fixed nodes; only their text changes (see {@link describe}). */
  private readonly tip: {
    rowGenome: HTMLElement
    genomeTimes: HTMLElement
    colGenome: HTMLElement
    genomes: HTMLElement
    rowName: HTMLElement
    times: HTMLElement
    colName: HTMLElement
    pos: HTMLElement
    distance: HTMLElement
    count: HTMLElement
  }
  /** Cached geometry for {@link positionTooltip}; never read during a pointer move. */
  private tipSize = { width: 0, height: 0 }
  private hostSize = { width: 0, height: 0 }
  private tipAt: { x: number; y: number } | null = null
  private tipFrame = 0

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
    this.tip = {
      rowGenome: el('span', { class: 'cell-tip-name' }),
      genomeTimes: el('span', { class: 'cell-tip-x', text: '×' }),
      colGenome: el('span', { class: 'cell-tip-name' }),
      genomes: el('div', { class: 'cell-tip-pair cell-tip-genomes hidden' }),
      rowName: el('span', { class: 'cell-tip-name' }),
      times: el('span', { class: 'cell-tip-x', text: '×' }),
      colName: el('span', { class: 'cell-tip-name' }),
      pos: el('div', { class: 'cell-tip-pos' }),
      distance: el('div', { class: 'cell-tip-distance hidden' }),
      count: el('div', { class: 'cell-tip-count' }),
    }
    this.tip.genomes.append(this.tip.rowGenome, this.tip.genomeTimes, this.tip.colGenome)
    this.tooltip = el(
      'div',
      { class: 'cell-tip hidden' },
      // The genome leads, where there is one: it is the coarser fact, and on a
      // metagenome it is the one that says what you are looking at. The contig
      // under it is the finer answer to the same question.
      this.tip.genomes,
      el('div', { class: 'cell-tip-pair' }, this.tip.rowName, this.tip.times, this.tip.colName),
      this.tip.pos,
      this.tip.distance,
      this.tip.count,
    )
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
      onLabelClick: (axis, block) => this.options.onLabelClick?.(axis, block.label),
      // Only wired when the view wants it; without it a drag zooms, which is
      // the renderer's own behaviour.
      ...(options.onSelectRegion === undefined
        ? {}
        : { onSelect: (box: SelectionBox) => this.emitSelection(box) }),
    })
    this.heatmap.attach()
    this.colorbar = new ColorbarView(this.barCanvas, { caption: 'count' })

    const transformSelect = el('select', { class: 'select' })
    this.transformSelect = transformSelect
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
    this.colormapSelect = colormapSelect
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
            optionToggle('breaks'),
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
      for (const name of options.levels) {
        levelSelect.appendChild(
          el('option', { value: name, text: options.levelLabels?.[name] ?? name }),
        )
      }
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

    // The legend turns on its side when the plot is as wide as the screen and
    // the only room left is underneath it. Same breakpoint as the stylesheet's,
    // stated once here because the canvas cannot read a media query.
    this.narrowWatcher = watchMedia(NARROW_QUERY, (narrow) => {
      this.colorbar.setOrientation(narrow ? 'horizontal' : 'vertical')
      this.colorbar.resize()
      this.schedule()
    })

    this.observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            // The tooltip's host is `wrap`, which is what is observed — so the
            // one place that already learns this box's size is also the only
            // place that needs to.
            const box = entries[0]?.contentRect
            if (box !== undefined) this.hostSize = { width: box.width, height: box.height }
            this.heatmap.resize()
            this.colorbar.resize()
            this.schedule()
          })
    this.observer?.observe(wrap)
    // The canvas has no size until it is in the document; size it once laid out.
    requestAnimationFrame(() => {
      this.hostSize = { width: wrap.clientWidth, height: wrap.clientHeight }
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
    this.narrowWatcher()
    this.observer?.disconnect()
    this.heatmap.detach()
    if (this.frame !== 0) cancelAnimationFrame(this.frame)
    if (this.tipFrame !== 0) cancelAnimationFrame(this.tipFrame)
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
  exportCanvas(dpi: number, now = new Date()): HTMLCanvasElement {
    const scale = scaleForDpi(dpi)
    const plot = this.heatmap.cssSize
    const bar = this.colorbar.cssSize
    const gap = 10
    const width = plot.width + gap + bar.width
    const body = Math.max(plot.height, bar.height)

    const out = document.createElement('canvas')
    const ctx = out.getContext('2d')
    if (ctx === null) throw new Error('Could not acquire a 2d context for the export canvas.')

    // Measured before the canvas is sized, because the caption decides how tall
    // it has to be — a long provenance line on a narrow figure wraps rather
    // than running off the edge. Setting `width`/`height` resets the context,
    // so nothing is drawn until after.
    // Aligned with the *drawn* frame, not the canvas: the plot is inset by
    // however much its labels need, and a caption flush with the canvas edge
    // hangs off the left of the picture it belongs to.
    const left = this.heatmap.dataRect.x
    const caption = this.figureCaption(now)
    const lines = captionLines(ctx, caption, Math.max(120, width - left))
    const captionHeight = captionHeightOf(lines)

    // Pre-flight, because the failure mode is silent: past a browser's canvas
    // cap, setting `width`/`height` leaves a blank canvas rather than throwing,
    // so the export lands as a white rectangle with no explanation. Asked here
    // rather than at the top of the method because the caption is part of the
    // height, and a figure that fits without it can fail with it.
    const height = body + captionHeight
    const fits = largestDpiThatFits(width, height)
    if (fits !== null && fits < dpi) {
      throw new Error(
        `${dpi} dpi would need a ${Math.round(width * scale)}×${Math.round(height * scale)} px ` +
          `canvas, which is past what a browser will draw. ${fits} dpi is the largest that fits ` +
          'this figure.',
      )
    }

    out.width = Math.max(1, Math.round(width * scale))
    out.height = Math.max(1, Math.round(height * scale))

    // The plot draws from the canvas origin and clears as it goes, so it goes
    // first and the background goes on underneath at the end. The caption is
    // *below* the figure, which is where a caption goes and — not incidentally
    // — the only place that needs no offset for anything else.
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

    if (lines.length > 0) {
      const palette = readCanvasPalette()
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'left'
      let y = body + CAPTION_TOP
      for (const line of lines) {
        const height = line.strong ? CAPTION_TITLE_LINE : CAPTION_DETAIL_LINE
        ctx.font = line.strong ? CAPTION_TITLE_FONT : CAPTION_DETAIL_FONT
        ctx.fillStyle = line.strong ? readPageText() : palette.labelColor
        // Baseline a little above the line's foot, so the two lines read as one
        // block rather than as two evenly spaced rows.
        ctx.fillText(line.text, left, y + height - 4)
        y += height
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
    }

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

  /**
   * What the figure is of, with the coordinates it is *actually framed at*.
   *
   * A view is panned and zoomed before it is exported, and the export keeps
   * that framing — so a figure captioned `XVI` when it shows 200–600 kb of
   * chromosome XVI is wrong in the way that matters, and the reader has no way
   * to tell from the picture. The suffix is written in the region grammar, so
   * it can be pasted back into the region box to return to this exact view.
   *
   * Omitted only where it would add nothing: an axis with no single coordinate
   * system (a genome, whose axis is contigs), a block with two different axes
   * (contig × contig), and a picture that is the whole sequence from base zero.
   */
  private framedSubject(): string {
    const subject = this.exportName
    if (subject.includes(' × ')) return subject
    const range = this.heatmap.framedRange('rows')
    if (range === null || range.whole) return subject
    const name = subject.split(':')[0]
    return `${name}:${fmt.int(Math.round(range.start))}-${fmt.int(Math.round(range.end))}`
  }

  /**
   * What the exported figure says it is: the subject, and where it came from.
   *
   * Everything here is a fact a reader of the figure would otherwise have to be
   * told separately, and every one of them has been the subject of an email
   * about a screenshot: which file, which genome, which region, what bin size,
   * and when — a contact map of the same region at two bin sizes is two
   * different pictures, and a map re-exported after a re-run is a third.
   */
  figureCaption(now: Date): { title: string; detail: string } {
    const context = this.options.caption
    const subject = this.framedSubject()
    const genome = context?.genome
    // `›` rather than `·` between the two: a contig belongs *inside* its
    // genome, which is the relationship the breadcrumb draws the same way. Not
    // added when the subject already opens with the genome — a genome's own
    // view names it once, and a pair names both.
    const title =
      genome === undefined || genome === '' || subject.startsWith(genome)
        ? subject
        : `${genome} › ${subject}`

    const parts: string[] = []
    if (context?.file !== undefined && context.file !== '') parts.push(context.file)
    if (this.options.binsize > 0) parts.push(`${fmt.bp(this.options.binsize)} bins`)
    if (this.level === 'contig') parts.push('contig level')
    if (this.options.balance === true) parts.push('balanced')
    parts.push(this.transform === 'none' ? 'linear' : this.transform)
    parts.push(captionStamp(now))
    return { title, detail: parts.join(' · ') }
  }

  /** Save the figure. The status line under the buttons reports what happened. */
  private async save(format: 'png' | 'pdf'): Promise<void> {
    const now = new Date()
    // The stamp is in the name because two exports of the same view are the
    // same filename otherwise, and the second one silently becomes
    // `figure (1).png` in a downloads folder nobody can later put in order.
    const name = `${exportBaseName(this.exportName)}-${fileStamp(now)}-${this.exportDpi}dpi.${format}`
    this.exportStatus.textContent = `saving ${name}…`
    try {
      const canvas = this.exportCanvas(this.exportDpi, now)
      const caption = this.figureCaption(now)
      const blob =
        format === 'png'
          ? await canvasToPng(canvas)
          : await canvasToPdf(canvas, {
              dpi: this.exportDpi,
              title: caption.title,
              subject: caption.detail,
              created: now,
            })
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
    // A cell is a bin, so a block's span in cells is its length in base pairs:
    // the contigs worth naming in a 300-contig genome are the long ones, and
    // they are named however many short ones surround them. Above bin level a
    // cell *is* a contig or a genome, every block is one cell wide, and the
    // rule has nothing to read — hence 0, which turns it off.
    this.heatmap.setLabelMinSpan(
      data.level === 'bin' ? LABEL_MIN_SPAN_BP / Math.max(1, this.options.binsize) : 0,
    )
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

  /**
   * Adopt a colour scale that came from *outside* this panel — a shared link, a
   * back button, a command — without echoing it back out.
   *
   * The echo is the point of the separation. {@link rescale} is what a control
   * in this card calls, and it announces the change so the URL follows;
   * `applyScale` is what the owning view calls when the URL moved first, and
   * announcing it again would be a loop. Programmatic assignment to a `<select>`
   * fires no `change` event, so the two listeners above stay quiet.
   *
   * This is what lets `App.render` treat a colour-only state change as a repaint
   * rather than as a reason to rebuild the view and re-read the matrix.
   */
  applyScale(scale: {
    transform?: Transform
    colormap?: string
    vmin?: number
    vmax?: number
  }): void {
    this.transform = scale.transform ?? this.transform
    this.colormap = scale.colormap ?? this.colormap
    this.manualVmin = scale.vmin
    this.manualVmax = scale.vmax
    this.transformSelect.value = this.transform
    this.colormapSelect.value = this.colormap
    this.heatmap.setScale(this.scale())
    this.schedule()
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
      //
      // Guarded, because a pan changes neither. The legend is 256 `fillRect`s
      // and a tick layout; unguarded it redrew all of it every frame of every
      // drag, to produce the same picture it already had.
      const effective = this.heatmap.effectiveScale
      if (!sameColorScale(effective, this.painted)) {
        this.painted = { ...effective }
        this.colorbar.setScale(effective)
        this.colorbar.draw()
      }
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

  /**
   * Resolve a dragged box to one block per axis, and hand it on.
   *
   * Each axis is resolved through the block the *anchor* sits in on that axis —
   * where the drag began, which is what says which sequence the box is of when
   * it overruns a boundary — and clamped to that block. A box in the trans
   * corner therefore comes back naming both sequences, and the view opens their
   * intersection.
   */
  private emitSelection(box: SelectionBox): void {
    const emit = this.options.onSelectRegion
    const data = this.data
    if (emit === undefined || data === null) return
    const rowGroup = groupAt(data.rowGroups, box.anchor.row)
    const colGroup = groupAt(data.colGroups, box.anchor.col)
    if (rowGroup === undefined || colGroup === undefined) return

    const level = data.level
    const sameBlock = rowGroup.label === colGroup.label && rowGroup.start === colGroup.start
    if (level !== 'bin') {
      // A cell *is* the unit here, so same block is the whole of same window.
      emit({
        rows: { label: rowGroup.label },
        cols: { label: colGroup.label },
        diagonal: sameBlock,
        level,
        anchor: box.anchor,
      })
      return
    }
    const rows = this.axisSelection(rowGroup, box.rows, data.rowExtent[0])
    const cols = this.axisSelection(colGroup, box.cols, data.colExtent[0])
    if (rows === null || cols === null) return
    emit({ rows, cols, diagonal: sameBlock && onDiagonal(box), level, anchor: box.anchor })
  }

  /**
   * One axis of a selection: the block, and the base pairs of it the box covers.
   *
   * The last bin of a contig is usually a short one, so the bin arithmetic runs
   * past the end of the sequence — `VII` at 2 kb is 546 bins, which is
   * 1,092,000 bp against a chromosome of 1,090,940 — and the region built from
   * that is refused as out of bounds by the very reader that would open it. The
   * contig's own length has the last word wherever the reader has sent one.
   */
  private axisSelection(
    group: AxisGroup,
    span: [number, number],
    blockStart: number,
  ): SelectedAxis | null {
    const lo = Math.max(span[0], group.start)
    const hi = Math.min(span[1], group.end)
    if (!(hi > lo)) return null
    const binsize = this.options.binsize
    const start = Math.max(0, bpWithin(group, lo, blockStart, binsize))
    const raw = bpWithin(group, hi, blockStart, binsize)
    const end = group.unitLength === undefined ? raw : Math.min(raw, group.unitLength)
    return { label: group.label, range: [start, end] }
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
    const distance = separationOf(rowGroup, colGroup, cell, data.level, this.options.binsize)

    setReadout(
      `${rowLabel}  ×  ${colLabel}` +
        (distance === null ? '' : `   ${fmt.bp(distance)} apart`) +
        `   count ${count}`,
    )

    // The names in full, unabbreviated, and each name written *once*: the axis
    // labels are elided when the blocks are narrow, so the tooltip is often the
    // only place the pair is spelled out — but on the diagonal of a contig map
    // the old layout printed `NODE_8524_len_441121` four times, and the number
    // the pointer is actually asking about was the last thing on the card.
    const sameBlock = rowGroup !== undefined && colGroup !== undefined && rowGroup.label === colGroup.label
    const rowPos = positionIn(rowGroup, cell.row, data.level, this.options.binsize, rowStart)
    const colPos = positionIn(colGroup, cell.col, data.level, this.options.binsize, colStart)

    // Written in place rather than rebuilt. `replaceChildren` with five fresh
    // elements ran on every pointer move — 4-6 allocations and as many
    // detachments per event, on the highest-frequency path in the app — to
    // produce a card whose *shape* almost never changes. Only the text does.
    const tip = this.tip
    tip.rowName.textContent = sameBlock ? rowGroup.label : (rowGroup?.label ?? '—')
    tip.times.classList.toggle('hidden', sameBlock)
    tip.colName.classList.toggle('hidden', sameBlock)
    if (!sameBlock) tip.colName.textContent = colGroup?.label ?? '—'
    const hasPos = rowPos !== null && colPos !== null
    tip.pos.classList.toggle('hidden', !hasPos)
    if (hasPos) tip.pos.textContent = `${rowPos}  ×  ${colPos}`

    // The genome line, on the same "written once when it is one name" rule as
    // the contigs above it. Absent entirely where the reader sent no genomes —
    // a plain cooler, or any view that already is one genome.
    const rowGenome = groupAt(data.rowGenomes, cell.row)?.label
    const colGenome = groupAt(data.colGenomes, cell.col)?.label
    const hasGenome = rowGenome !== undefined || colGenome !== undefined
    tip.genomes.classList.toggle('hidden', !hasGenome)
    if (hasGenome) {
      const oneGenome = rowGenome === colGenome
      tip.rowGenome.textContent = rowGenome ?? '—'
      tip.genomeTimes.classList.toggle('hidden', oneGenome)
      tip.colGenome.classList.toggle('hidden', oneGenome)
      if (!oneGenome) tip.colGenome.textContent = colGenome ?? '—'
    }

    tip.distance.classList.toggle('hidden', distance === null)
    if (distance !== null) tip.distance.textContent = `${fmt.bp(distance)} apart`
    tip.count.textContent = `count ${count}`

    this.tooltip.classList.remove('hidden')
    if (at !== undefined) this.placeTooltip(at.x, at.y)
  }

  /**
   * Keep the tooltip inside the panel.
   *
   * Offset from the pointer so it never sits under it, and flipped to the other
   * side near an edge — a tooltip clipped by the panel border is worse than no
   * tooltip, because it looks like the value is missing.
   *
   * Both measurements it needs are *cached*, and that is the whole point. The
   * old version read `offsetWidth`/`offsetHeight` immediately after writing the
   * card's contents, which forces the browser to lay out the document
   * synchronously — twice per pointer move, at whatever rate the device reports
   * them. The host's size now comes from the `ResizeObserver` that already
   * watches it, and the tooltip's own size is re-measured at most once per
   * frame, inside a `requestAnimationFrame` where layout is already clean.
   */
  private placeTooltip(x: number, y: number): void {
    this.tipAt = { x, y }
    this.positionTooltip()
    if (this.tipFrame !== 0) return
    this.tipFrame = requestAnimationFrame(() => {
      this.tipFrame = 0
      const width = this.tooltip.offsetWidth
      const height = this.tooltip.offsetHeight
      if (width === this.tipSize.width && height === this.tipSize.height) return
      this.tipSize = { width, height }
      this.positionTooltip()
    })
  }

  /** Write the transform from the cached geometry. No reads, no layout. */
  private positionTooltip(): void {
    const at = this.tipAt
    if (at === null) return
    const pad = 14
    const { width, height } = this.tipSize
    const host = this.hostSize
    const left = at.x + pad + width > host.width ? at.x - pad - width : at.x + pad
    const top = at.y + pad + height > host.height ? at.y - pad - height : at.y + pad
    this.tooltip.style.transform = `translate(${Math.max(0, left)}px, ${Math.max(0, top)}px)`
  }
}

/**
 * Whether two resolved scales would paint the same legend.
 *
 * Every field the colourbar reads, and nothing else — a change of matrix with
 * an identical scale draws an identical bar.
 */
function sameColorScale(a: ColorScale, b: ColorScale | null): boolean {
  return (
    b !== null &&
    a.vmin === b.vmin &&
    a.vmax === b.vmax &&
    a.transform === b.transform &&
    a.colormap === b.colormap &&
    a.balanced === b.balanced
  )
}

/** Which group covers a block-local offset. Absent list, absent answer. */
export function groupAt(
  groups: AxisGroup[] | undefined,
  offset: number,
): AxisGroup | undefined {
  if (groups === undefined) return undefined
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
 * How far apart the two ends of a cell are along the sequence, in base pairs.
 *
 * The genomic distance is what a cis contact *means* — a Hi-C map is read by
 * how the signal falls off with separation, and until now the tooltip made you
 * subtract two coordinates to get it. `null` where the question has no answer,
 * which is three cases and each is a refusal rather than a gap:
 *
 * - **above bin level**, where a cell is a whole contig or genome and its two
 *   ends have no positions to subtract;
 * - **across two contigs**, where the contact is trans and a distance along the
 *   sequence does not exist — not a large one, none;
 * - **on the diagonal**, where it is zero and saying so is noise on the line
 *   that matters least.
 *
 * Same contig is decided by `unitStart`, not by name: it is the absolute bin
 * the contig itself begins at, so it distinguishes two blocks of one contig
 * (a rectangular region view of `contig × the same contig`, where the labels
 * agree and the arithmetic still has one origin) without trusting a string.
 */
export function separationOf(
  rowGroup: AxisGroup | undefined,
  colGroup: AxisGroup | undefined,
  cell: Cell,
  level: 'bin' | 'contig' | 'genome',
  binsize: number,
): number | null {
  if (level !== 'bin' || !(binsize > 0)) return null
  if (rowGroup === undefined || colGroup === undefined) return null
  if (rowGroup.unitStart === undefined || rowGroup.unitStart !== colGroup.unitStart) return null
  // Straight from the absolute bin indices: the two `unitStart` terms are equal
  // and cancel, so this is exact and needs neither axis's block origin.
  const bins = Math.abs(cell.rowBin - cell.colBin)
  return bins === 0 ? null : bins * binsize
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

/** Body text in the theme in force, for the exported caption's first line. */
function readPageText(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--text').trim()
  return value === '' ? '#16181d' : value
}

/** Caption geometry, in CSS pixels. */
const CAPTION_TOP = 14
const CAPTION_TITLE_LINE = 19
const CAPTION_DETAIL_LINE = 16
const CAPTION_TITLE_FONT = '600 15px system-ui, sans-serif'
const CAPTION_DETAIL_FONT = '12px system-ui, sans-serif'

/** One drawn caption line; `strong` is the subject, the rest is provenance. */
interface CaptionLine {
  text: string
  strong: boolean
}

/** Total height of a caption block, in CSS pixels. */
function captionHeightOf(lines: CaptionLine[]): number {
  if (lines.length === 0) return 0
  return (
    CAPTION_TOP +
    lines.reduce((sum, line) => sum + (line.strong ? CAPTION_TITLE_LINE : CAPTION_DETAIL_LINE), 0)
  )
}

/**
 * The caption as drawn lines, wrapped to the figure's width.
 *
 * The detail line is a middot-separated list, so it breaks at those separators
 * and nowhere else — a provenance line broken mid-filename reads as two files.
 * The subject line is one name and is left to overflow rather than be cut: a
 * truncated genome name is worse than a wide figure.
 */
function captionLines(
  ctx: CanvasRenderingContext2D,
  caption: { title: string; detail: string },
  width: number,
): CaptionLine[] {
  const lines: CaptionLine[] = []
  if (caption.title !== '') lines.push({ text: caption.title, strong: true })
  if (caption.detail === '') return lines

  ctx.font = CAPTION_DETAIL_FONT
  const fits = (text: string): boolean => ctx.measureText(text).width <= width
  if (fits(caption.detail)) {
    lines.push({ text: caption.detail, strong: false })
    return lines
  }
  let line = ''
  for (const part of caption.detail.split(' · ')) {
    const candidate = line === '' ? part : `${line} · ${part}`
    if (line !== '' && !fits(candidate)) {
      lines.push({ text: line, strong: false })
      line = part
    } else {
      line = candidate
    }
  }
  if (line !== '') lines.push({ text: line, strong: false })
  return lines
}

/** The page colour an export is flattened onto — the theme in force. */
function readPageBackground(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  return value === '' ? '#ffffff' : value
}

/** The width below which the plot takes the whole column; `styles.css` agrees. */
const NARROW_QUERY = '(max-width: 34rem)'

/**
 * Watch a media query, calling back with its state now and on every change.
 * Returns the teardown.
 */
function watchMedia(query: string, onChange: (matches: boolean) => void): () => void {
  const media = window.matchMedia?.(query)
  if (media === undefined) return () => {}
  const listener = (): void => onChange(media.matches)
  media.addEventListener?.('change', listener)
  onChange(media.matches)
  return () => media.removeEventListener?.('change', listener)
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
 * The genome runs become the drawn boundaries only where the reader says so
 * (`genomeBoundaries`), which is the whole-metagenome overview and nothing
 * else. Elsewhere they are a fact the tooltip reports and not a line: a
 * whole-genome view of a metacool is still read contig by contig, and moving
 * its separators out to the genomes would coarsen a picture nobody asked to
 * have coarsened.
 */
export function separatorsFor(data: MatrixResult): SeparatorSet {
  const toSeparators = (groups: AxisGroup[]): Separator[] =>
    groups.map((group) => ({ at: group.start, label: group.label }))

  // A whole-metagenome view is a picture of *genomes*. Where the reader marks
  // its genome runs as the boundaries, those are the only ones drawn: 20,000
  // contig hairlines over 4,000 genome blocks is a grey wash, and it hides the
  // block structure the view exists to show. They go in both sets so the axis
  // is also *labelled* by genome — the fine set is what `labelBlocks` reads —
  // while the heavier stroke, drawn at the same coordinates, is what the eye
  // lands on.
  const draw = data.genomeBoundaries === true
  const rowUnits = (draw ? data.rowGenomes : undefined) ?? data.rowGroups
  const colUnits = (draw ? data.colGenomes : undefined) ?? data.colGroups
  const set: SeparatorSet = {
    rows: toSeparators(rowUnits),
    cols: toSeparators(colUnits),
  }
  // The *same array*, not a second copy of it. Where the genome runs are the
  // boundaries they are both sets, and the renderer skips the fine pass when it
  // recognises the identity — otherwise it stroked several thousand hairlines
  // and then stroked the heavier line over exactly the same coordinates.
  if (draw && data.rowGenomes !== undefined) set.groupRows = set.rows
  if (draw && data.colGenomes !== undefined) set.groupCols = set.cols
  return set
}

/**
 * Whether a box straddles the diagonal, in cells.
 *
 * Compared in cells rather than in base pairs because that is where the
 * question is exact, and with a bin of slack at each end because the marquee is
 * square in *pixels*: the two axes convert those pixels through their own
 * scales, and a plot whose gutters differ by a pixel turns a square on the
 * diagonal into ranges that differ by one cell. A whole bin of tolerance is
 * still far tighter than any box a hand can draw off the diagonal.
 */
export function onDiagonal(box: SelectionBox): boolean {
  return Math.abs(box.rows[0] - box.cols[0]) <= 1 && Math.abs(box.rows[1] - box.cols[1]) <= 1
}

/**
 * One axis of a selection as a region string, in the grammar the region box
 * takes.
 *
 * Rounded to whole base pairs and written without separators, so it is both a
 * legal range (§5.4) and something that can be pasted back. Above bin level
 * there is no range to write and the block's own name is the answer.
 */
export function axisRegion(axis: SelectedAxis): string {
  if (axis.range === undefined) return axis.label
  const [start, end] = axis.range
  return `${axis.label}:${Math.round(start)}-${Math.round(end)}`
}

/**
 * What to say when the picture is coarser than the data.
 *
 * A block wider than {@link RASTER_MAX_DIM} is drawn through a pooled raster:
 * one pixel per `stride x stride` block of cells, carrying the strongest value
 * under it. That is the right trade — a 12,975-bin genome at one pixel per bin
 * is 585 MB of RGBA for an image no screen can show, and the *maximum* is what
 * keeps a sparse map's bright cell from being averaged into its empty
 * neighbours — but until now nothing said it was happening. The summary claimed
 * "12,975 x 12,975 cells rendered", the crosshair then reported four different
 * coordinates and four different values inside one visible square, and there
 * was no way to tell which of the two was lying.
 *
 * Two things a reader needs and cannot deduce: that the picture is pooled, and
 * that **zooming does not sharpen it** — the pooling is per block, not per view,
 * so the answer is to open a smaller block, not to magnify this one.
 *
 * `null` when every cell has its own pixel, which is every region and nearly
 * every MAG.
 */
export function poolingNote(
  nrows: number,
  ncols: number,
): { phrase: string } | null {
  const strideY = rasterStride(nrows)
  const strideX = rasterStride(ncols)
  if (strideX === 1 && strideY === 1) return null
  return {
    phrase: `aggregated ${strideX} × ${strideY} bins to a pixel`
  }
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

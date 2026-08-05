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

import {
  formatPoint,
  mintMarkId,
  type ManualArrowhead,
  type ManualLine,
  type ManualMark,
  type ManualPoint,
  type ManualStore,
} from '../annotations/manual'
import type { AnnotationStore } from '../annotations/store'
import type { AnnotationEntry } from '../annotations/types'
import type { AnnotationClient } from '../annotations/worker/client'
import { LABEL_MIN_SPAN_BP, MAX_CATEGORICAL_TICKS } from '../constants'
import { ColorbarView, formatCount } from '../render/colorbar'
import { locusAxisFrom, type LocusAxis } from '../render/locus'
import {
  drawArrowheads,
  drawDiagonalFeatures,
  drawManualLines,
  drawPairs,
  type OverlayFrame,
} from '../render/overlays'
import { AnnotationLanes, type LaneEdge, type LaneGeometry } from './AnnotationLanes'
import { alignable, blendAcrossDiagonal, matchGain } from '../render/compare'
import {
  COLORMAP_NAMES,
  COLOR_VISION_SAFE_COLORMAPS,
  DEFAULT_UI_COLORMAP,
} from '../render/colormaps'
import {
  CROSSHAIR_COLOR,
  HeatmapView,
  type AxisCoords,
  type Cell,
  type PlotOptions,
  type SelectionBox,
  type SeparatorSet,
} from '../render/heatmap'
import { rasterStride } from '../render/heatmap'
import { inverseTransform, transformValue } from '../render/scale'
import type { ColorScale, DenseMatrix, Separator, Transform } from '../types'
import type { AxisGroup, MatrixResult } from '../worker/protocol'
import { ClipRange } from './ClipRange'
import { button, el, field, fmt } from './dom'
import {
  EXPORT_DPI_CHOICES,
  EXPORT_FORMATS,
  type ExportFormat,
  canvasToPng,
  captionStamp,
  downloadBlob,
  exportBaseName,
  fileStamp,
  largestDpiThatFits,
  scaleForDpi,
} from './export'
import { openMenu, type MenuItem } from './Menu'
import { VectorPage } from './vector'
import { setReadout } from './readout'
import {
  MATRIX_OPTIONS,
  PLOT_OPTION_LABELS,
  TRACK_OPTIONS,
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
  /**
   * Draw annotations beside and on the matrix (spec §8).
   *
   * Absent on every view of a `.metacool`, which is not a decision this panel
   * makes: the shell only supplies it for a file with no genome layer (§8.5).
   * With it absent the panel is byte for byte the panel it was before
   * annotations existed — no lanes, no listeners, no worker.
   */
  annotations?: AnnotationContext
  /**
   * Draw a second file in the lower-left triangle (`render/compare.ts`).
   *
   * Present only while two files are open. The *data* arrives through
   * {@link MatrixPanel.setData}; this is what the panel needs to talk about it:
   * whose numbers are on which side of the diagonal, and the one control the
   * comparison has of its own.
   */
  compare?: ComparePresentation
}

export interface ComparePresentation {
  /** The two file names, in order: above the diagonal, then below it. */
  labels: [string, string]
  /**
   * Whether the second file's counts are scaled to the first's bright end.
   *
   * Off by default, because one scale for both is the stronger claim: the same
   * colour is the same number of contacts, wherever it is. On when the two
   * files differ enough in depth that the shallower is a blank triangle.
   */
  normalise: boolean
  onNormaliseChange(on: boolean): void
}

/** What the panel needs to draw annotations against this file. */
export interface AnnotationContext {
  store: AnnotationStore
  manual: ManualStore
  client: AnnotationClient
  /**
   * A contig's length in base pairs, from the contigs table.
   *
   * Passed as a lookup rather than a table because an *aggregated* axis carries
   * one cell per contig and no length of its own, and because the panel has no
   * business knowing the reader's table shapes.
   */
  contigLength(name: string): number | undefined
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
  /**
   * The second file's legend, beside the first.
   *
   * One colormap, two value axes. The colours are shared — that is what makes
   * the picture one picture — so the only thing a second bar can add is what
   * those colours are worth in the other file's counts, which after a
   * normalisation is a different number at every position.
   */
  private readonly barCanvas2: HTMLCanvasElement
  private readonly heatmap: HeatmapView
  private readonly colorbar: ColorbarView
  private readonly colorbar2: ColorbarView
  private readonly barSlot: HTMLElement
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
  private exportFormat: ExportFormat = 'pdf'
  /** What the figure is called, for the download name. */
  private exportName = 'contact-map'

  private data: MatrixResult | null = null
  /**
   * The second file's block, when one is open, and the factor applied to it.
   *
   * Kept beside the merged values rather than only merged into them, because a
   * reader hovering a cell wants *both* numbers — the whole question a compared
   * map asks is how the two differ here — and after the merge only one of them
   * is still in the matrix.
   */
  private second: { data: MatrixResult; gain: number } | null = null
  private transform: Transform
  private colormap: string
  private manualVmin: number | undefined
  private manualVmax: number | undefined
  private level: 'bin' | 'contig'
  private frame = 0
  /** The scale the colourbar was last drawn for; `null` until it has been. */
  private painted: ColorScale | null = null
  /**
   * The annotation lanes, or `null` on a file that cannot carry them (§8.5).
   *
   * Every use of it is optional-chained rather than guarded by a flag, so the
   * "no annotations" path is the absence of an object rather than a branch that
   * has to be kept correct in six places.
   */
  private readonly lanes: AnnotationLanes | null
  /** The grid holding the map and its lanes; the tooltip's positioning parent. */
  private readonly grid: HTMLElement
  /** The cell under the pointer, so the lanes can continue the crosshair. */
  private hoverCell: Cell | null = null
  /**
   * Where the pointer is over a lane stack, in that stack's canvas pixels.
   *
   * The hairline this drives runs across the lanes *and* the map, which is why
   * it is held here rather than inside {@link lanes}: the map's half is painted
   * through the overlay hook, and both halves have to come from one number or
   * they would meet at a kink.
   */
  private laneHover: { edge: LaneEdge; along: number } | null = null
  /**
   * The lane whose far border the pointer is on, so the grip can be drawn.
   *
   * Drawn rather than shown as a cursor, which is the rule this canvas already
   * follows: the pointer is the arrowhead everywhere here, so an affordance that
   * lived in the cursor would not exist. Same accent rule the 1D browser marks
   * its own lane borders with, because it is the same gesture on the same kind
   * of edge.
   */
  private laneGrip: string | null = null
  /**
   * The two axes as annotations see them, rebuilt with every block.
   *
   * Held here rather than only inside {@link lanes}, because the overlays and
   * the click-to-place picker need them too — and three copies of the same
   * mapping is exactly what §8.4 exists to prevent.
   */
  private locusAxes: { rows: LocusAxis | null; cols: LocusAxis | null } = { rows: null, cols: null }
  /** A picking mode in progress; see {@link armPicking}. */
  private picking: {
    /** Called once per click, for as long as the mode is on. */
    onPoint(point: { rows: ManualPoint; cols: ManualPoint }): void
    /** Called once when the mode ends, however it ends. */
    end(): void
  } | null = null
  /** The tooltip's fixed nodes; only their text changes (see {@link describe}). */
  private readonly tip: {
    matrix: HTMLElement
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
    /** The lane tooltip's block: a heading and however many lines it has. */
    lane: HTMLElement
    laneTitle: HTMLElement
    laneLines: HTMLElement
  }
  /** Cached geometry for {@link positionTooltip}; never read during a pointer move. */
  private tipSize = { width: 0, height: 0 }
  private hostSize = { width: 0, height: 0 }
  private tipAt: { x: number; y: number } | null = null
  private tipFrame = 0
  /** Teardowns for the lane canvases' own pointer listeners. */
  private readonly laneListeners: Array<() => void> = []
  /** The stack thicknesses the stylesheet was last told about, per edge. */
  private laneBudget = { bottom: -1, right: -1 }

  constructor(private readonly options: MatrixPanelOptions) {
    this.transform = options.initial?.transform ?? 'log1p'
    this.colormap = options.initial?.colormap ?? DEFAULT_UI_COLORMAP
    this.manualVmin = options.initial?.vmin
    this.manualVmax = options.initial?.vmax
    this.level = options.initial?.level ?? 'bin'

    this.canvas = el('canvas', { class: 'heatmap-canvas' })
    this.barCanvas = el('canvas', { class: 'colorbar-canvas' })
    this.barCanvas2 = el('canvas', { class: 'colorbar-canvas hidden' })
    // A tooltip follows the pointer with the same three facts as the readout.
    // Both exist on purpose: the tooltip answers "what is under my cursor"
    // without a glance away from the matrix, and the readout keeps the last
    // answer visible after the pointer has moved on.
    // Two shapes in one card: the matrix's row × column × count, and a lane's
    // heading with however many lines the feature under the pointer has. One
    // element rather than two, because there is one pointer and it can only be
    // over one of them — and because the placement logic is fiddly enough that
    // a second copy of it would drift.
    this.tip = {
      matrix: el('div', { class: 'cell-tip-block' }),
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
      lane: el('div', { class: 'cell-tip-block hidden' }),
      laneTitle: el('div', { class: 'cell-tip-title' }),
      laneLines: el('div', { class: 'cell-tip-lines' }),
    }
    this.tip.genomes.append(this.tip.rowGenome, this.tip.genomeTimes, this.tip.colGenome)
    this.tip.matrix.append(
      // The genome leads, where there is one: it is the coarser fact, and on a
      // metagenome it is the one that says what you are looking at. The contig
      // under it is the finer answer to the same question.
      this.tip.genomes,
      el('div', { class: 'cell-tip-pair' }, this.tip.rowName, this.tip.times, this.tip.colName),
      this.tip.pos,
      this.tip.distance,
      this.tip.count,
    )
    this.tip.lane.append(this.tip.laneTitle, this.tip.laneLines)
    this.tooltip = el('div', { class: 'cell-tip hidden' }, this.tip.matrix, this.tip.lane)
    this.titleNode = el('h2', { class: 'panel-title', text: '' })
    this.overlay = el('div', { class: 'panel-overlay hidden' })

    this.heatmap = new HeatmapView(this.canvas, {
      plotOptions: getPlotOptions(),
      ...readCanvasPalette(this.canvas),
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
    this.watchContextMenu()
    // The two bars share a colormap and therefore a units word; what differs is
    // which triangle each measures, and the mark says so in the width a file
    // name would not fit into. The names themselves are on the compare card and
    // on the two File cards, both of which carry the same two marks.
    this.colorbar = new ColorbarView(this.barCanvas, {
      caption: 'count',
      ...(options.compare === undefined ? {} : { prefix: '◥ ' }),
    })
    this.colorbar2 = new ColorbarView(this.barCanvas2, { caption: 'count', prefix: '◣ ' })

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

    // Saving a figure is one question with three parts — how fine, what file,
    // go — so it is one row: resolution, format, and the button that acts on
    // both. Two buttons labelled by format made the choice of file into the
    // action itself, which left the resolution stranded in a row of its own two
    // lines above the thing it applied to.
    const dpiSelect = el('select', {
      class: 'select',
      title: 'Dots per inch of the saved figure. 96 is what is on screen; 300 is print.',
    })
    for (const dpi of EXPORT_DPI_CHOICES) {
      dpiSelect.appendChild(el('option', { value: String(dpi), text: `${dpi} dpi` }))
    }
    dpiSelect.value = String(this.exportDpi)
    dpiSelect.addEventListener('change', () => {
      this.exportDpi = Number(dpiSelect.value)
    })

    const formatSelect = el('select', {
      class: 'select',
      title:
        'PDF is a one-page document holding the figure losslessly, at the size the DPI implies; ' +
        'PNG is the same picture as an image.',
    })
    for (const format of EXPORT_FORMATS) {
      formatSelect.appendChild(el('option', { value: format, text: format.toUpperCase() }))
    }
    formatSelect.value = this.exportFormat
    formatSelect.addEventListener('change', () => {
      this.exportFormat = formatSelect.value as ExportFormat
    })

    this.exportStatus = el('span', { class: 'clip-note export-note' })

    this.plotEl = el(
      'div',
      { class: 'controls-card' },
      el('h3', { class: 'controls-title', text: 'Plot' }),
      el(
        'div',
        { class: 'panel-controls' },
        // Split by what each one draws on, because half of these do nothing to
        // the matrix and half do nothing to the tracks — and an undifferentiated
        // row of seven made a reader try each in turn to find out which. Stored
        // together all the same: a crosshair turned off here is off in the 1D
        // browser too, since it is the same preference about the same gesture.
        el(
          'div',
          { class: 'field field-block' },
          el('span', { class: 'field-label', text: 'tracks' }),
          el('div', { class: 'plot-option-row' }, ...TRACK_OPTIONS.map(optionToggle)),
        ),
        el(
          'div',
          { class: 'field field-block' },
          el('span', { class: 'field-label', text: 'matrix' }),
          el('div', { class: 'plot-option-row' }, ...MATRIX_OPTIONS.map(optionToggle)),
        ),
        button('fit to view', () => this.fit(), {
          class: 'btn btn-wide',
          title: 'Undo every pan and zoom (key: 0, or a double click on the plot)',
        }),
        el(
          'div',
          { class: 'field field-block' },
          el('span', { class: 'field-label', text: 'export' }),
          el(
            'div',
            { class: 'export-row' },
            dpiSelect,
            formatSelect,
            button('Save', () => void this.save(this.exportFormat), {
              class: 'btn',
              title: 'Save the figure, at the resolution and in the format chosen beside this',
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

    if (options.compare !== undefined) {
      const compare = options.compare
      const normalise = el('input', { class: 'checkbox', type: 'checkbox' })
      normalise.checked = compare.normalise
      normalise.addEventListener('change', () => compare.onNormaliseChange(normalise.checked))
      controls.unshift(
        field(
          'match depth',
          normalise,
          `Scale ${compare.labels[1]}'s counts so its 99th percentile meets ${compare.labels[0]}'s, ` +
            'so the two triangles saturate together. Off, one colour is one count on both sides of ' +
            'the diagonal — the stronger claim, and wrong to read when the files differ in depth.',
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

    const wrap = el('div', { class: 'heatmap-wrap' }, this.canvas, this.overlay)

    this.lanes =
      options.annotations === undefined
        ? null
        : new AnnotationLanes({
            store: options.annotations.store,
            manual: options.annotations.manual,
            client: options.annotations.client,
            onChange: () => this.schedule(),
          })

    // The map and its lanes are one grid, so a lane canvas is the same width as
    // the map's canvas by construction rather than by arrangement — and the
    // tooltip, parented here, can float over either.
    this.grid = el(
      'div',
      { class: 'panel-grid' },
      wrap,
      ...(this.lanes === null ? [] : [this.lanes.rightEl, this.lanes.bottomEl]),
      this.tooltip,
    )
    if (this.lanes !== null) {
      this.watchLane('bottom', this.lanes.bottomEl)
      this.watchLane('right', this.lanes.rightEl)
    }
    if (options.annotations !== undefined) {
      this.heatmap.setOverlayPainter((ctx, frame) => this.paintOverlays(ctx, frame))
      // Escape abandons a half-finished pick. On the window rather than the
      // canvas: the gesture is armed from a button in the sidebar, so the focus
      // is very often not on the plot at the moment the reader changes their
      // mind.
      const onEscape = (event: KeyboardEvent): void => {
        if (event.key === 'Escape' && this.picking !== null) {
          event.preventDefault()
          this.cancelPicking()
        }
      }
      window.addEventListener('keydown', onEscape)
      this.laneListeners.push(() => window.removeEventListener('keydown', onEscape))
      // The cards write to the stores and the panel reads from them; neither
      // needs a reference to the other, which is what lets the cards live in the
      // shell's sidebar while the plot lives inside a view the shell replaces.
      this.laneListeners.push(options.annotations.store.subscribe(() => this.schedule()))
      this.laneListeners.push(options.annotations.manual.subscribe(() => this.schedule()))
    }

    // The colourbar sits immediately right of the plot and is deliberately
    // short: it is a legend, and a legend as tall as the figure reads as a
    // second panel competing with it.
    this.barSlot = el('div', { class: 'colorbar-slot' }, this.barCanvas, this.barCanvas2)
    const body = el('div', { class: 'panel-body' }, this.grid, this.barSlot)

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
      this.heatmap.setPalette(readCanvasPalette(this.canvas))
      this.schedule()
    })

    // The legend turns on its side when the plot is as wide as the screen and
    // the only room left is underneath it. Same breakpoint as the stylesheet's,
    // stated once here because the canvas cannot read a media query.
    this.narrowWatcher = watchMedia(NARROW_QUERY, (narrow) => {
      this.colorbar.setOrientation(narrow ? 'horizontal' : 'vertical')
      this.colorbar2.setOrientation(narrow ? 'horizontal' : 'vertical')
      this.resizeBars()
      this.schedule()
    })

    this.observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            // The *grid* is what is observed, not the plot: it is the tooltip's
            // positioning parent, and it is the box that changes when a lane
            // appears — which the plot's own size does not.
            this.hostSize = { width: this.grid.clientWidth, height: this.grid.clientHeight }
            this.heatmap.resize()
            this.resizeBars()
            this.schedule()
          })
    this.observer?.observe(this.grid)
    // The canvas has no size until it is in the document; size it once laid out.
    // And no *computed palette* either — the three colours it borrows come from
    // the centre column it is about to be mounted in — so read them again here,
    // rather than trust the fallbacks the constructor had to use.
    requestAnimationFrame(() => {
      this.hostSize = { width: this.grid.clientWidth, height: this.grid.clientHeight }
      this.heatmap.setPalette(readCanvasPalette(this.canvas))
      this.heatmap.resize()
      this.resizeBars()
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
    // A picking mode outlives nothing: the plot it was placing marks on is going
    // away. Ended here rather than left to be garbage-collected, because the
    // card that armed it is *not* going away — it lives in the shell — and it
    // learns the mode is over from this call. Without it, navigating with the
    // mode on leaves a button reading "Done" that nothing will ever answer.
    this.cancelPicking()
    this.unsubscribePlotOptions()
    this.themeWatchers()
    this.narrowWatcher()
    this.observer?.disconnect()
    this.heatmap.detach()
    for (const off of this.laneListeners) off()
    this.laneListeners.length = 0
    // The lanes' sample cache goes with the panel, not with the file: the store
    // outlives this view, and a cache keyed on a view's own geometry would be
    // answering the next view's questions with the last one's data.
    this.lanes?.destroy()
    if (this.frame !== 0) cancelAnimationFrame(this.frame)
    if (this.tipFrame !== 0) cancelAnimationFrame(this.tipFrame)
  }

  /**
   * Re-measure everything after the *shell* changed how much room there is.
   *
   * Folding or dragging a side panel is the one size change nothing here can
   * observe: the plot is normally sized by the window's height, so a wider
   * column resizes no box the `ResizeObserver` is watching — and yet the plot
   * has to grow into the space and re-centre itself in it. The view's own
   * resizes still come through the observer; this is for the ones that arrive
   * from outside it.
   */
  remeasure(): void {
    this.hostSize = { width: this.grid.clientWidth, height: this.grid.clientHeight }
    this.heatmap.resize()
    this.resizeBars()
    this.schedule()
  }

  /**
   * Re-measure the legend, and the second one when two files are open.
   *
   * `painted` is cleared with it: the bars are only redrawn when the resolved
   * scale changes, and a resize changes neither — but it does throw away what
   * was on the canvas, so the guard has to be told the picture is gone.
   */
  private resizeBars(): void {
    this.colorbar.resize()
    if (this.second === null) return
    this.colorbar2.resize()
    this.painted = null
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
    // The lanes are part of the figure, so they are part of its box. A track
    // exported without them is a picture of a claim with its evidence cropped
    // off.
    const rightLanes = this.lanes?.thicknessOf('right') ?? 0
    const bottomLanes = this.lanes?.thicknessOf('bottom') ?? 0
    // A compared figure carries both legends, side by side, because the two
    // value axes are the only thing distinguishing whose counts a colour is.
    const bar2 = this.second === null ? { width: 0, height: 0 } : this.colorbar2.cssSize
    const width = plot.width + rightLanes + gap + bar.width + bar2.width
    const body = Math.max(plot.height + bottomLanes, bar.height, bar2.height)

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
    // Placed exactly as the grid places them — below the plot, and beside it —
    // and *redrawn* at the export scale rather than blown up from the screen
    // canvases, so a 300 dpi figure has 300 dpi track names.
    this.lanes?.renderInto(ctx, this.laneGeometry(), scale)

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
    const barLeft = plot.width + rightLanes + gap
    ctx.drawImage(barCanvas, Math.round(barLeft * scale), 0)

    if (this.second !== null) {
      const second = document.createElement('canvas')
      second.width = Math.max(1, Math.round(bar2.width * scale))
      second.height = Math.max(1, Math.round(bar2.height * scale))
      const secondCtx = second.getContext('2d')
      if (secondCtx !== null) this.colorbar2.renderTo(secondCtx, scale)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(second, Math.round((barLeft + bar.width) * scale), 0)
    }

    if (lines.length > 0) {
      const palette = readCanvasPalette(this.canvas)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'left'
      let y = body + CAPTION_TOP
      for (const line of lines) {
        const height = line.strong ? CAPTION_TITLE_LINE : CAPTION_DETAIL_LINE
        ctx.font = line.strong ? CAPTION_TITLE_FONT : CAPTION_DETAIL_FONT
        ctx.fillStyle = line.strong ? readPageText(this.canvas) : palette.labelColor
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
   * The same figure as a vector page: the matrix as an image, everything else
   * as paths and text.
   *
   * The honest hybrid, and the reason the browser's page and this one are the
   * same class. A contact matrix *is* a raster — twelve thousand bins are
   * pixels, and writing them as a million rectangles would be a larger, slower
   * file of the same picture — but the axes, the tick labels, the boundary
   * marks, the tracks beside it, the legend and the caption are none of them
   * pixels, and a reader who wants to restyle a figure wants exactly those.
   *
   * Drawn at 1:1 rather than at a DPI, because a vector page has no resolution.
   * The image inside it does, and it is the screen's — which is the resolution
   * the matrix actually has, since a bin is a bin however large the page is.
   */
  private async vectorFigure(now: Date): Promise<Blob> {
    const plot = this.heatmap.cssSize
    const bar = this.colorbar.cssSize
    const bar2 = this.second === null ? { width: 0, height: 0 } : this.colorbar2.cssSize
    const gap = 10
    const rightLanes = this.lanes?.thicknessOf('right') ?? 0
    const bottomLanes = this.lanes?.thicknessOf('bottom') ?? 0
    const width = plot.width + rightLanes + gap + bar.width + bar2.width
    const body = Math.max(plot.height + bottomLanes, bar.height, bar2.height)

    const measure = document.createElement('canvas').getContext('2d')
    if (measure === null) throw new Error('Could not measure the caption.')
    const left = this.heatmap.dataRect.x
    const caption = this.figureCaption(now)
    const lines = captionLines(measure, caption, Math.max(120, width - left))
    const height = body + captionHeightOf(lines)

    const page = new VectorPage(width, height)
    const ctx = page.ctx
    // The page under the drawing, first: a PDF is drawn in order and has no
    // `destination-over`.
    ctx.fillStyle = readPageBackground()
    ctx.fillRect(0, 0, width, height)

    this.heatmap.renderTo(ctx, 1)
    this.lanes?.renderInto(ctx, this.laneGeometry(), 1)

    // Each legend where the grid puts it. `renderTo` draws from the origin and
    // sets an absolute transform, so an offset has to be applied under it —
    // which is what `setOrigin` is for, and why this is not the intermediate
    // canvas the raster path needs.
    const barLeft = plot.width + rightLanes + gap
    page.setOrigin(barLeft, 0)
    this.colorbar.renderTo(ctx, 1)
    if (this.second !== null) {
      page.setOrigin(barLeft + bar.width, 0)
      this.colorbar2.renderTo(ctx, 1)
    }
    page.setOrigin(0, 0)

    if (lines.length > 0) {
      const palette = readCanvasPalette(this.canvas)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'left'
      let y = body + CAPTION_TOP
      for (const line of lines) {
        const step = line.strong ? CAPTION_TITLE_LINE : CAPTION_DETAIL_LINE
        ctx.font = line.strong ? CAPTION_TITLE_FONT : CAPTION_DETAIL_FONT
        ctx.fillStyle = line.strong ? readPageText(this.canvas) : palette.labelColor
        ctx.fillText(line.text, left, y + step - 4)
        y += step
      }
    }
    return page.toBlob({ title: caption.title, created: now })
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

  /** Save the figure. The status line under the row reports what happened. */
  private async save(format: ExportFormat): Promise<void> {
    const now = new Date()
    // The stamp is in the name because two exports of the same view are the
    // same filename otherwise, and the second one silently becomes
    // `figure (1).png` in a downloads folder nobody can later put in order.
    const name = `${exportBaseName(this.exportName)}-${fileStamp(now)}-${this.exportDpi}dpi.${format}`
    this.exportStatus.textContent = `saving ${name}…`
    try {
      const blob =
        format === 'png'
          ? await canvasToPng(this.exportCanvas(this.exportDpi, now))
          : await this.vectorFigure(now)
      downloadBlob(blob, name)
      this.exportStatus.textContent = `${name} · ${fmt.bytes(blob.size)}`
    } catch (err) {
      // Nothing here is worth an error screen: the view is intact and the user
      // can try a smaller size. Say what failed and stay put.
      this.exportStatus.textContent =
        err instanceof Error ? `export failed: ${err.message}` : 'export failed'
    }
  }

  /**
   * Everything drawn on the data: the overlay card's files, then the hand-drawn
   * marks over them.
   *
   * Files first and marks second, because a mark is what the reader put there
   * and it must not end up underneath a circle from a loop table.
   */
  private paintOverlays(ctx: CanvasRenderingContext2D, frame: OverlayFrame): void {
    const context = this.options.annotations
    if (context === undefined) return
    const palette = readCanvasPalette(this.canvas)

    for (const entry of context.store.overlays()) {
      if (entry.payload?.kind === 'features') {
        drawDiagonalFeatures(ctx, frame, this.locusAxes, entry.payload.data, {
          colour: entry.style.colour,
          opacity: entry.style.opacity,
          shape: entry.style.shape,
        })
      } else if (entry.payload?.kind === 'pairs') {
        drawPairs(ctx, frame, this.locusAxes, entry.payload.data, {
          colour: entry.style.colour,
          opacity: entry.style.opacity,
          radius: entry.style.radius,
        })
      }
    }

    drawManualLines(ctx, frame, this.locusAxes, context.manual.lines)
    drawArrowheads(ctx, frame, this.locusAxes, context.manual.arrowheads, palette.labelHaloColor)
    this.paintLaneGuide(ctx, frame)
  }

  /**
   * The lane hairline, continued across the map.
   *
   * One line, not a crosshair. A pointer on the bottom stack is naming a
   * *column* and has said nothing about which row, so a horizontal line through
   * it would be an answer to a question nobody asked — and two lines crossing at
   * an arbitrary point read as a cell being pointed at, which is exactly what is
   * not happening.
   *
   * The coordinate needs no conversion: the lane canvases share the map
   * canvas's grid cell on the axis they run along, so a pixel `x` on the bottom
   * stack is the same `x` here. Clipped to the data rather than the plot, so it
   * stops where the matrix does instead of running out over empty margin.
   */
  private paintLaneGuide(ctx: CanvasRenderingContext2D, frame: OverlayFrame): void {
    const guide = this.laneHover
    if (guide === null) return
    const { data, dpr } = frame
    const at = (Math.round(guide.along * dpr - 0.5) + 0.5) / dpr
    if (guide.edge === 'bottom') {
      if (at < data.x || at > data.x + data.width) return
    } else if (at < data.y || at > data.y + data.height) return

    ctx.save()
    ctx.beginPath()
    ctx.rect(data.x, data.y, data.width, data.height)
    ctx.clip()
    ctx.strokeStyle = CROSSHAIR_COLOR
    ctx.lineWidth = Math.max(1 / dpr, 0.75)
    ctx.globalAlpha = 0.8
    ctx.beginPath()
    if (guide.edge === 'bottom') {
      ctx.moveTo(at, data.y)
      ctx.lineTo(at, data.y + data.height)
    } else {
      ctx.moveTo(data.x, at)
      ctx.lineTo(data.x + data.width, at)
    }
    ctx.stroke()
    ctx.restore()
  }

  /**
   * Place marks by clicking the map, for as long as the mode is on.
   *
   * A **mode**, not a count. It used to collect a fixed number of points and
   * resolve, which meant one arming per mark: click the button, click the map,
   * click the button again. Marking up a figure is not one gesture, it is eight
   * — the corners of four domains, or every loop worth an arrowhead — and the
   * trip back to the sidebar between each was the whole cost of the feature.
   * Now the mode stays on and each click reports a point; the card ends it, and
   * so does Escape.
   *
   * While armed, a click *places* rather than navigates — the only sensible
   * reading of a click during a "pick a point" gesture, and the reason this is a
   * mode rather than a modifier.
   *
   * Each point is reported on **both** axes, because a click is one cell and a
   * cell has a row coordinate and a column coordinate. A vertical line wants the
   * column, a horizontal one the row, and an arrowhead wants both — so the panel
   * hands over both and lets the card take what it means.
   *
   * @returns a function that ends the mode, for a card being torn down.
   */
  armPicking(
    onPoint: (point: { rows: ManualPoint; cols: ManualPoint }) => void,
    onEnd: () => void = () => {},
  ): () => void {
    this.picking?.end()
    this.picking = { onPoint, end: onEnd }
    this.canvas.classList.add('picking')
    return () => this.cancelPicking()
  }

  /** End a picking mode. Safe to call when none is in progress. */
  cancelPicking(): void {
    const picking = this.picking
    this.picking = null
    this.canvas.classList.remove('picking')
    picking?.end()
  }

  /** `true` while a click would place a mark rather than navigate. */
  get isPicking(): boolean {
    return this.picking !== null
  }

  /**
   * The right-click menu on the map: place a mark exactly here.
   *
   * "Here" is the cell under the pointer, which is the thing a right click is
   * *for* — the two ways in that already existed are typing a coordinate you
   * know and arming a mode and clicking, and neither answers "this one, the one
   * I am pointing at". The coordinates go in the menu beside the actions so the
   * reader can see what they are about to mark before they mark it.
   *
   * Only where the file can carry marks (§8.5) and only over the data, not over
   * the gutters: a right click on a label is the browser's menu, and taking it
   * over to offer nothing would be worse than leaving it.
   */
  private watchContextMenu(): void {
    const onMenu = (event: MouseEvent): void => {
      const context = this.options.annotations
      if (context === undefined) return
      const box = this.canvas.getBoundingClientRect()
      const cell = this.heatmap.cellAt(event.clientX - box.left, event.clientY - box.top)
      if (cell === null) return
      const at = this.locusOf(cell)
      if (at === null) return
      event.preventDefault()

      const { manual } = context
      const add = (mark: Omit<ManualLine, 'id' | 'colour'> | Omit<ManualArrowhead, 'id' | 'colour'>): void => {
        manual.add({ ...mark, id: mintMarkId(), colour: manual.nextColour() } as ManualMark)
      }
      openMenu(event.clientX, event.clientY, [
        { label: 'Mark this point' },
        {
          label: 'Vertical line',
          hint: formatPoint(at.cols),
          run: () => add({ kind: 'line', axis: 'vertical', at: at.cols }),
        },
        {
          label: 'Horizontal line',
          hint: formatPoint(at.rows),
          run: () => add({ kind: 'line', axis: 'horizontal', at: at.rows }),
        },
        {
          label: 'Crosshair',
          hint: 'both axes',
          // The row's coordinate, because a crosshair is drawn from one point on
          // both axes and on the diagonal — where these are nearly always placed
          // — the two are the same.
          run: () => add({ kind: 'line', axis: 'both', at: at.rows }),
        },
        {
          label: 'Loop',
          hint: `${formatPoint(at.rows)} × ${formatPoint(at.cols)}`,
          run: () => add({ kind: 'arrowhead', a: at.rows, b: at.cols }),
        },
        { label: 'This cell' },
        {
          label: 'Copy coordinates',
          hint: 'to the clipboard',
          run: () => {
            void navigator.clipboard?.writeText(
              `${formatPoint(at.rows)}\t${formatPoint(at.cols)}`,
            )
          },
        },
      ])
    }
    this.canvas.addEventListener('contextmenu', onMenu)
    this.laneListeners.push(() => this.canvas.removeEventListener('contextmenu', onMenu))
  }

  /**
   * Turn a clicked cell into a point on each axis.
   *
   * The cell's *centre*, not its corner: a click lands somewhere inside a cell,
   * and reporting its left edge would put every hand-placed mark half a bin
   * earlier than where the reader aimed.
   */
  private locusOf(cell: Cell): { rows: ManualPoint; cols: ManualPoint } | null {
    const rows = this.locusAxes.rows?.unitToLocus(cell.row + 0.5) ?? null
    const cols = this.locusAxes.cols?.unitToLocus(cell.col + 0.5) ?? null
    if (rows === null || cols === null) return null
    return {
      rows: { contig: rows.contig, bp: Math.round(rows.bp) },
      cols: { contig: cols.contig, bp: Math.round(cols.bp) },
    }
  }

  /**
   * The lanes' view of the frame about to be drawn.
   *
   * Every number comes from the heatmap rather than from this panel: the scales
   * are the objects the heatmap's pan and zoom write, and the two rects are the
   * ones it draws in. That is the whole of §8.4's "nothing computes a second
   * mapping", stated as one function.
   */
  private laneGeometry(): LaneGeometry {
    const palette = readCanvasPalette(this.canvas)
    return {
      plot: this.heatmap.plotRect,
      data: this.heatmap.dataRect,
      colScale: this.heatmap.scaleX,
      rowScale: this.heatmap.scaleY,
      cssWidth: this.heatmap.cssSize.width,
      cssHeight: this.heatmap.cssSize.height,
      hover: this.hoverCell === null ? null : { row: this.hoverCell.row, col: this.hoverCell.col },
      crosshair: getPlotOptions().crosshair,
      guide: this.laneHover,
      grip: this.laneGrip,
      palette: {
        guide: palette.labelColor,
        halo: palette.labelHaloColor,
        crosshair: CROSSHAIR_COLOR,
      },
    }
  }

  /**
   * Follow the pointer over one lane stack.
   *
   * The lanes get their own listeners rather than sharing the heatmap's, because
   * they are separate canvases and a pointer over one is not over the other.
   * What they share is the tooltip, which is why the coordinates are converted
   * to the grid's — the tooltip is parented there and knows nothing about which
   * canvas asked for it.
   */
  /**
   * Dragging a lane: its border resizes it, its body reorders the stack.
   *
   * Both gestures already existed in the side panel — a height box and a drag
   * handle in the card — and both are being asked for *here* because here is
   * where the tracks are being looked at. A reader comparing two profiles moves
   * them next to each other and makes the interesting one taller, and having to
   * cross the window to a list to do either is the reason the card grew a
   * handle in the first place.
   *
   * Pointer capture, and the same reason the panel columns take it: a drag that
   * leaves a 44-pixel strip — which every resize does — must not be dropped on
   * the map underneath, where it would become a pan.
   */
  private dragLane(edge: LaneEdge, canvas: HTMLCanvasElement): void {
    const lanes = this.lanes
    const context = this.options.annotations
    if (lanes === null || context === undefined) return

    /**
     * Three gestures on one surface, told apart without a modifier key.
     *
     * A press on a lane's *border* is a resize, because that is the only thing a
     * border can be dragged for. A press on its *body* waits for the first
     * movement and reads its direction: **along** the axis is a pan, which is
     * what dragging a track beside the map has always done and must keep doing,
     * and **across** it is a reorder, because moving a lane up the stack is a
     * movement up the stack. The two are perpendicular, so no gesture has to be
     * guessed at and neither has to be given up.
     */
    let drag:
      | { id: string; kind: 'size' | 'order' | 'pan' | 'undecided'; from: number; along: number; size: number }
      | null = null

    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0 || this.picking !== null) return
      const box = canvas.getBoundingClientRect()
      const hit = lanes.laneAt(edge, event.clientX - box.left, event.clientY - box.top)
      if (hit === null) return
      drag = {
        id: hit.entry.id,
        kind: hit.onBorder ? 'size' : 'undecided',
        from: edge === 'bottom' ? event.clientY : event.clientX,
        along: edge === 'bottom' ? event.clientX : event.clientY,
        size: hit.entry.style.size,
      }
      canvas.setPointerCapture(event.pointerId)
      event.preventDefault()
    }

    const onMove = (event: PointerEvent): void => {
      const box = canvas.getBoundingClientRect()
      if (drag === null) {
        // Not dragging, and the cursor does not change. The arrowhead is what
        // points *at* a base pair, and it is the same shape over the map, over
        // the lanes and over the 1D browser — a hand appearing on the way from
        // one to the other would be saying they are different surfaces, which is
        // the one thing they are not. What a draggable border gets instead is
        // the accent rule the browser draws for it, which is an affordance the
        // reader can see rather than one they have to discover.
        const hit = lanes.laneAt(edge, event.clientX - box.left, event.clientY - box.top)
        canvas.style.cursor = ''
        const grip = hit?.onBorder === true ? hit.entry.id : null
        if (grip !== this.laneGrip) {
          this.laneGrip = grip
          this.schedule()
        }
        return
      }
      const now = edge === 'bottom' ? event.clientY : event.clientX
      const alongNow = edge === 'bottom' ? event.clientX : event.clientY

      if (drag.kind === 'undecided') {
        const across = Math.abs(now - drag.from)
        const along = Math.abs(alongNow - drag.along)
        // A few pixels of slack before committing: the first event of a drag is
        // usually one pixel in a direction nobody meant.
        if (Math.max(across, along) < DRAG_SLACK) return
        drag.kind = along > across ? 'pan' : 'order'
        canvas.classList.add('grabbing')
      }

      if (drag.kind === 'pan') {
        const delta = alongNow - drag.along
        drag.along = alongNow
        if (delta === 0) return
        // `panBy` takes a *canvas* displacement, which is what this is: the lane
        // and the map share their pixels on this axis by construction (§8.4).
        if (edge === 'bottom') this.heatmap.panBy(delta, 0)
        else this.heatmap.panBy(0, delta)
        return
      }

      if (drag.kind === 'size') {
        // Thickness grows *away* from the map on both edges, so the delta is the
        // pointer's own displacement in the across direction.
        const next = Math.round(drag.size + (now - drag.from))
        context.store.restyle(drag.id, { size: Math.max(LANE_MIN_SIZE, Math.min(400, next)) })
        return
      }

      // Reordering: the lane lands where the pointer is, counted in lane
      // boundaries rather than in pixels, so a tall lane and a short one are one
      // step apart either way.
      const across = edge === 'bottom' ? event.clientY - box.top : event.clientX - box.left
      const bounds = lanes.boundariesOf(edge)
      let to = 0
      while (to + 1 < bounds.length && across >= bounds[to + 1]) to++
      context.store.move(drag.id, to)
    }

    const onUp = (event: PointerEvent): void => {
      if (drag === null) return
      drag = null
      canvas.style.cursor = ''
      canvas.classList.remove('grabbing')
      canvas.releasePointerCapture(event.pointerId)
    }

    const onMenu = (event: MouseEvent): void => {
      const box = canvas.getBoundingClientRect()
      const hit = lanes.laneAt(edge, event.clientX - box.left, event.clientY - box.top)
      if (hit === null) return
      event.preventDefault()
      openLaneMenu(event.clientX, event.clientY, hit.entry, context.store)
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('contextmenu', onMenu)
    this.laneListeners.push(() => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('contextmenu', onMenu)
    })
  }

  private watchLane(edge: LaneEdge, canvas: HTMLCanvasElement): void {
    const onMove = (event: MouseEvent): void => {
      const lanes = this.lanes
      if (lanes === null) return
      const box = canvas.getBoundingClientRect()
      const x = event.clientX - box.left
      const y = event.clientY - box.top

      // The hairline first, and through a repaint rather than a second canvas:
      // it crosses the lane stack and the map, and both are redrawn from this
      // one number on the next frame.
      const along = edge === 'bottom' ? x : y
      const before = this.laneHover
      if (before === null || before.edge !== edge || before.along !== along) {
        this.laneHover = { edge, along }
        this.schedule()
      }

      const readout = lanes.readout(edge, x, y, this.laneGeometry())
      if (readout === null) {
        this.tooltip.classList.add('hidden')
        return
      }
      this.tip.matrix.classList.add('hidden')
      this.tip.lane.classList.remove('hidden')
      // The position, and only the position. Naming the hovered lane here as
      // well was saying what the pointer already says: the tooltip is beside the
      // lane it is about, and the row for that lane is marked below.
      this.tip.laneTitle.textContent = readout.position
      this.tip.laneLines.replaceChildren(
        ...readout.rows.map((row) =>
          el(
            'div',
            { class: row.here ? 'cell-tip-line cell-tip-here' : 'cell-tip-line' },
            el('span', { class: 'cell-tip-chip', style: { background: row.colour } }),
            // In the track's own colour, which is the legend the picture already
            // uses — the lane is drawn in it and so is its name on the lane.
            el('span', {
              class: 'cell-tip-key',
              text: `${row.label}:`,
              style: { color: row.colour },
            }),
            el('span', { class: 'cell-tip-val', text: row.value }),
          ),
        ),
        ...readout.detail.map((line) => el('div', { class: 'cell-tip-line', text: line })),
      )
      this.tooltip.classList.remove('hidden')
      this.placeTooltip(canvas.offsetLeft + x, canvas.offsetTop + y)
    }
    const onLeave = (): void => {
      this.tooltip.classList.add('hidden')
      if (this.laneGrip !== null) {
        this.laneGrip = null
        this.schedule()
      }
      if (this.laneHover !== null) {
        this.laneHover = null
        this.schedule()
      }
    }
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mouseleave', onLeave)
    this.laneListeners.push(() => {
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mouseleave', onLeave)
    })
    this.driveFromLane(edge, canvas)
    this.dragLane(edge, canvas)
  }

  /**
   * Let a lane stack pan and zoom the map.
   *
   * A lane is a picture of the same window the map shows, drawn through the same
   * scales — so dragging one and dragging the map are the same gesture on the
   * same data, and a track you could read but not move was an odd exception a
   * reader has to discover. Dragging a bottom lane sideways scrolls the columns;
   * dragging a right lane up and down scrolls the rows.
   *
   * Only along the shared axis. A bottom lane says nothing about rows, so a
   * vertical drag on one has no meaning to forward — and forwarding it anyway
   * would move the map in a direction the pointer never travelled over anything
   * that represents it.
   *
   * The **zoom is not** restricted that way, because the map's zoom is one
   * scalar for both axes: a wheel over a lane zooms exactly as a wheel over the
   * map does, holding the position under the pointer fixed on the shared axis
   * and the middle of the data on the other. Anchoring the other axis anywhere
   * else would be inventing a row the reader never pointed at.
   */
  private driveFromLane(edge: LaneEdge, canvas: HTMLCanvasElement): void {
    /** The perpendicular anchor: the centre of the data actually on screen. */
    const middle = (): { x: number; y: number } => {
      const data = this.heatmap.dataRect
      return { x: data.x + data.width / 2, y: data.y + data.height / 2 }
    }

    const onWheel = (event: WheelEvent): void => {
      // The same two rules the map's own wheel handler follows: a sideways
      // two-finger scroll is the browser's back gesture and is left alone, and
      // the factor is exponential in the delta so a trackpad's many small events
      // and a wheel's few large ones compose to the same total zoom.
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      event.preventDefault()
      const box = canvas.getBoundingClientRect()
      const at = middle()
      if (edge === 'bottom') at.x = event.clientX - box.left
      else at.y = event.clientY - box.top
      this.heatmap.zoomAt(at.x, at.y, Math.exp(-event.deltaY * 0.002))
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    this.laneListeners.push(() => canvas.removeEventListener('wheel', onWheel))
  }

  /**
   * Load a block. `HeatmapView` refits and recomputes the auto range (§7.1).
   *
   * `second` is the same block read from the second open file, and it is merged
   * across the matrix diagonal *here* rather than by the caller: the merge has
   * to happen exactly once per read, because `setMatrix` refits the view, and a
   * view that refitted whenever the colour scale moved would throw away the pan
   * and zoom the reader had arrived at.
   */
  setData(data: MatrixResult, title: string, second?: MatrixResult): void {
    this.data = data
    this.exportName = title === '' ? this.exportName : title
    this.titleNode.textContent = title
    this.second =
      second !== undefined && alignable(data, second)
        ? {
            data: second,
            gain: this.options.compare?.normalise === true ? matchGain(data, second) : 1,
          }
        : null
    // Two aligned blocks with two axes each — the merged values are the first
    // file's above the diagonal and the second's below, and everything else
    // about the block (its extents, its runs, its level) is unchanged, because
    // the two files agree on all of it. That agreement is what the compare gate
    // checks before either read is made.
    const dense =
      this.second === null
        ? toDense(data)
        : {
            ...toDense(data),
            values: blendAcrossDiagonal(data, this.second.data, { gain: this.second.gain }).values,
          }
    this.barCanvas2.classList.toggle('hidden', this.second === null)
    // Two legends need more room than one: each caption gains a triangle and
    // there are two of them side by side, and a clipped caption on a legend is
    // worse than a narrower plot.
    this.barSlot.classList.toggle('is-compare', this.second !== null)
    // The second legend is a function of the gain as well as of the colour
    // scale, and the gain is recomputed per block. Without this the legend
    // redraw is skipped whenever a *pinned* clip survives a navigation, and the
    // second file's ticks keep the previous block's numbers.
    this.painted = null
    this.heatmap.setMatrix(dense, separatorsFor(data))
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
    // The annotations' view of the same two axes. Rebuilt per block rather than
    // patched, so a stale mapping can never be drawn over fresh data — the same
    // rule `setAxisCoords` above follows by being cleared in `setMatrix`.
    const context = this.options.annotations
    if (context !== undefined) {
      const shared = { level: data.level, binsize: this.options.binsize, contigLength: context.contigLength }
      this.locusAxes = {
        rows: locusAxisFrom({ ...shared, runs: data.rowGroups, blockStart: data.rowExtent[0] }),
        cols: locusAxisFrom({ ...shared, runs: data.colGroups, blockStart: data.colExtent[0] }),
      }
      this.lanes?.setAxes(this.locusAxes)
    }
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
      this.syncLaneMetrics()
      this.heatmap.draw()
      // After the matrix and inside the same frame: the lanes read the scales
      // the heatmap has just written, so drawing them anywhere else would show
      // the previous frame's pan for one frame on every drag.
      this.lanes?.draw(this.laneGeometry())
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
        // The second file's legend measures the same colours in *its* counts.
        // With no gain the two bars carry identical numbers, and the second is
        // still worth drawing: what it says then is that the two are on one
        // scale, which is exactly the claim the reader is relying on.
        if (this.second !== null) {
          this.colorbar2.setScale(rescaledBy(effective, this.second.gain))
          this.colorbar2.draw()
        }
      }
      if (Number.isFinite(effective.vmin) && Number.isFinite(effective.vmax)) {
        this.clip.setValues(
          { vmin: effective.vmin, vmax: effective.vmax },
          this.manualVmin === undefined && this.manualVmax === undefined,
        )
      }
    })
  }

  /**
   * Tell the stylesheet how much vertical budget the bottom lanes take, and
   * re-measure whenever either stack changes thickness.
   *
   * The plot's size is `100vh` minus its furniture, and a stack of tracks under
   * it is furniture: without the property, six tracks push the map off the
   * bottom of the window. The *right* stack needs no property — the grid's own
   * `max-width` takes it out of the plot's width, since a percentage written
   * here would resolve against the plot's own track and chase its own tail — but
   * it still has to be watched, because a lane appearing beside the map resizes
   * the map just as surely as one appearing under it.
   *
   * Written only when a thickness changes, because assigning a custom property
   * invalidates layout and this runs on every frame of a drag.
   */
  private syncLaneMetrics(): void {
    const bottom = this.lanes?.thicknessOf('bottom') ?? 0
    const right = this.lanes?.thicknessOf('right') ?? 0
    if (bottom === this.laneBudget.bottom && right === this.laneBudget.right) return
    this.laneBudget = { bottom, right }
    this.grid.style.setProperty('--lane-bottom', `${bottom}px`)
    // Re-measure *now*, in the same frame, rather than waiting for the resize
    // observer. The observer watches the grid, and the grid's width is the wider
    // of the plot and the lane below it — so a plot that has just shrunk under a
    // lane still as wide as the plot used to be leaves the grid's box unchanged,
    // the observer silent, and the two canvases permanently out of step. This is
    // the one forced layout in the draw path, and it happens only when a lane is
    // added, removed or resized.
    this.heatmap.resize()
  }

  private emitClick(cell: Cell): void {
    if (this.data === null) return
    // A picking mode owns the click outright. Navigating *and* placing would put
    // the mark on a view the reader can no longer see. The mode stays on after
    // the mark is placed: it ends when the card or Escape says so, not when a
    // click lands.
    const picking = this.picking
    if (picking !== null) {
      const point = this.locusOf(cell)
      if (point !== null) picking.onPoint(point)
      return
    }
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
    // Recorded whatever happens: the lanes continue the crosshair through the
    // hovered column, and they can only do that if they are told it has moved.
    const moved =
      (this.hoverCell === null) !== (cell === null) ||
      (cell !== null && this.hoverCell !== null && (cell.row !== this.hoverCell.row || cell.col !== this.hoverCell.col))
    this.hoverCell = cell
    if (moved && this.lanes !== null && getPlotOptions().crosshair) this.schedule()

    if (cell === null || this.data === null) {
      setReadout('')
      this.tooltip.classList.add('hidden')
      return
    }
    this.tip.matrix.classList.remove('hidden')
    this.tip.lane.classList.add('hidden')
    const data = this.data
    const rowGroup = groupAt(data.rowGroups, cell.row)
    const colGroup = groupAt(data.colGroups, cell.col)
    // Positions are measured in absolute bin space, so each axis needs the bin
    // its own block starts at — they differ on a rectangular two-contig block.
    const rowStart = data.rowExtent[0]
    const colStart = data.colExtent[0]
    const rowLabel = describeAxis(rowGroup, cell.row, data.level, this.options.binsize, rowStart)
    const colLabel = describeAxis(colGroup, cell.col, data.level, this.options.binsize, colStart)
    // `cell.value` is what was *drawn*, which below the diagonal of a compared
    // map is the second file's count with any gain already in it. Neither half
    // of that is what a reader is asking about, so the numbers here come from
    // the blocks themselves: each file's own count, unscaled, at this cell.
    const compare = this.options.compare
    const slot = cell.row * data.ncols + cell.col
    const mine = this.second === null ? cell.value : data.values[slot]
    const count = Number.isNaN(mine) ? 'NaN (unbalanced)' : fmt.num(mine)
    const counts =
      this.second === null || compare === undefined
        ? `count ${count}`
        : `${compare.labels[0]} ${count}   ·   ${compare.labels[1]} ${
            Number.isNaN(this.second.data.values[slot])
              ? 'NaN (unbalanced)'
              : fmt.num(this.second.data.values[slot])
          }`
    const distance = separationOf(rowGroup, colGroup, cell, data.level, this.options.binsize)

    setReadout(
      `${rowLabel}  ×  ${colLabel}` +
        (distance === null ? '' : `   ${fmt.bp(distance)} apart`) +
        `   ${counts}`,
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

    // With two files open the count line carries both — the whole question a
    // compared map is asked at every position is how the two differ *here*, and
    // answering it with only the visible half would mean reading the picture
    // twice, once on each side of the diagonal, to compare one locus.
    tip.count.textContent = counts

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
 *
 * Read off `from` — a node inside the centre column — and *not* off the document
 * element. The centre column re-declares the light palette regardless of theme
 * (see `.content` in the stylesheet), because a contact map is a figure and its
 * colormaps are built for ink on white. Reading from the root instead gave a
 * dark-theme plot a black label halo on a white matrix, and exported it that
 * way. The fallbacks are the light values for the same reason: a canvas asked
 * before it is in the document has no computed custom properties, and the right
 * answer for it is the palette it is going to be mounted into.
 */
export function readCanvasPalette(from: Element): {
  labelColor: string
  labelHaloColor: string
  plotBorderColor: string
  /** A wash for alternating blocks — the browser's sequence bands. */
  bandColor: string
} {
  const style = getComputedStyle(from)
  const pick = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }
  return {
    labelColor: pick('--text-dim', '#5b6169'),
    labelHaloColor: pick('--bg', '#ffffff'),
    plotBorderColor: pick('--border-strong', '#b9bec5'),
    bandColor: pick('--bg-sunken', '#f6f7f8'),
  }
}

/**
 * Body text for the exported caption's first line.
 *
 * From the plot's own box, not the page's: the caption is drawn onto the figure,
 * which is light, so page text in a dark theme would have written it in pale
 * grey on white.
 */
function readPageText(from: Element): string {
  const value = getComputedStyle(from).getPropertyValue('--text').trim()
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

/**
 * The same colours, measured in the second file's counts.
 *
 * A gain of `g` multiplies the second file's values before they are coloured, so
 * a colour standing at transformed level `t` is `T⁻¹(t)` contacts in the first
 * file and `T⁻¹(t) / g` in the second. Converting the *bounds* that way and
 * handing the result to a second colourbar is all it takes: every tick it
 * derives is then in the second file's units, from the one implementation that
 * already knows how to derive them.
 */
function rescaledBy(scale: ColorScale, gain: number): ColorScale {
  if (!(gain > 0) || gain === 1) return scale
  const back = (value: number): number =>
    Number.isFinite(value)
      ? transformValue(inverseTransform(value, scale.transform) / gain, scale.transform)
      : value
  return { ...scale, vmin: back(scale.vmin), vmax: back(scale.vmax) }
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


/** The smallest a lane may be dragged to; below this it is a line, not a track. */
const LANE_MIN_SIZE = 12

/** How far a press must travel before it is a drag with a direction. */
const DRAG_SLACK = 3

/**
 * The right-click menu on a lane: its colour, and what its value axis spans.
 *
 * The two things the side panel offers for a track that a reader beside the map
 * actually reaches for, brought to where the track is. Colour opens the
 * browser's own picker — the same control the card uses, so the two cannot drift
 * — and the range is offered as the choices worth having rather than as two
 * boxes: auto, and the round steps around what is on screen. A number box in a
 * context menu is a form in a menu.
 */
export function openLaneMenu(
  x: number,
  y: number,
  entry: AnnotationEntry,
  store: AnnotationStore,
): void {
  const limits = entry.style.limits
  const items: MenuItem[] = [
    { label: entry.label },
    {
      label: 'Colour…',
      hint: entry.style.colour,
      // The browser's own picker, opened from a hidden input — the same control
      // the side panel's swatch is, so the two cannot come to disagree about
      // what a colour is. Built here rather than up front because a menu that is
      // opened and dismissed should leave nothing behind, and taken away again
      // on the commit *or* on the window coming back, which is what a cancelled
      // picker looks like from this side.
      run: () => {
        const swatch = el('input', {
          class: 'hidden-input',
          type: 'color',
          value: entry.style.colour,
        })
        swatch.addEventListener('input', () => store.restyle(entry.id, { colour: swatch.value }))
        const done = (): void => swatch.remove()
        swatch.addEventListener('change', done, { once: true })
        window.addEventListener('focus', done, { once: true })
        document.body.appendChild(swatch)
        swatch.click()
      },
    },
  ]

  if (entry.kind === 'track') {
    items.push(
      { label: 'Range' },
      {
        label: 'Auto',
        hint: 'this view',
        disabled: limits.auto,
        run: () => store.restyle(entry.id, { limits: { ...limits, auto: true } }),
      },
      ...[1, 5, 10, 50, 100].map((max) => ({
        label: `0 – ${max}`,
        disabled: !limits.auto && limits.min === 0 && limits.max === max,
        run: () => store.restyle(entry.id, { limits: { auto: false, min: 0, max } }),
      })),
    )
  }

  items.push(
    { label: 'This track' },
    {
      label: entry.visible ? 'Hide' : 'Show',
      run: () => store.update(entry.id, { visible: !entry.visible }),
    },
    { label: 'Remove', run: () => store.remove(entry.id) },
  )
  openMenu(x, y, items)
}

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
 * 2. **The defaults match `metacooler show`** (§7.1) — `log1p`, `afmhot_r`,
 *    `vmin = 0`, `vmax` at the 99th percentile of the non-zero *transformed*
 *    values, recomputed on every view change, with a manual override. `vmax:
 *    NaN` is how {@link HeatmapView} is asked for that default, so the number
 *    the CLI computes and the number drawn here come from one implementation.
 *
 * Interaction — drag, wheel, click, and the §7.2 keyboard pan and zoom — is
 * `HeatmapView.attach()`'s, not this panel's: the view owns the transform, so
 * it is the only thing that can move it coherently.
 */

import { MAX_CATEGORICAL_TICKS } from '../constants'
import { ColorbarView } from '../render/colorbar'
import { COLORMAP_NAMES, COLOR_VISION_SAFE_COLORMAPS, DEFAULT_COLORMAP } from '../render/colormaps'
import { HeatmapView, type Cell, type SeparatorSet } from '../render/heatmap'
import type { ColorScale, DenseMatrix, Separator, Transform } from '../types'
import type { AxisGroup, MatrixResult } from '../worker/protocol'
import { button, el, field, fmt } from './dom'

const TRANSFORMS: Transform[] = ['log1p', 'log10', 'none']

export interface MatrixPanelOptions {
  /** Bin size in bp, for the coordinate readout. */
  binsize: number
  /** Offered aggregation levels; omit for views with no level toggle. */
  levels?: Array<'bin' | 'contig'>
  initial?: { transform?: Transform; colormap?: string; vmax?: number; level?: 'bin' | 'contig' }
  onScaleChange?(scale: { transform: Transform; colormap: string; vmax?: number }): void
  onLevelChange?(level: 'bin' | 'contig'): void
  /** A cell was clicked; offsets are block-local, ids are absolute. */
  onCellClick?(cell: Cell, groups: { row?: AxisGroup; col?: AxisGroup }): void
  /**
   * Keep the colour controls out of the panel so the owning view can place them
   * elsewhere — the genome view stacks them in its sidebar, above the contig
   * list. The panel still owns them; only their mount point moves.
   */
  detachedControls?: boolean
}

export class MatrixPanel {
  readonly el: HTMLElement
  /**
   * The colour controls, as a self-contained card. Always built; mounted inside
   * {@link el} unless `detachedControls` was set, in which case the owning view
   * places it. Wired either way — the panel keeps the listeners.
   */
  readonly controlsEl: HTMLElement

  private readonly canvas: HTMLCanvasElement
  private readonly barCanvas: HTMLCanvasElement
  private readonly heatmap: HeatmapView
  private readonly colorbar: ColorbarView
  private readonly readout: HTMLElement
  private readonly titleNode: HTMLElement
  private readonly vmaxInput: HTMLInputElement
  private readonly autoVmax: HTMLInputElement
  private readonly overlay: HTMLElement
  private readonly observer: ResizeObserver | null

  private data: MatrixResult | null = null
  private transform: Transform
  private colormap: string
  private manualVmax: number | undefined
  private level: 'bin' | 'contig'
  private frame = 0

  constructor(private readonly options: MatrixPanelOptions) {
    this.transform = options.initial?.transform ?? 'log1p'
    this.colormap = options.initial?.colormap ?? DEFAULT_COLORMAP
    this.manualVmax = options.initial?.vmax
    this.level = options.initial?.level ?? 'bin'

    this.canvas = el('canvas', { class: 'heatmap-canvas' })
    this.barCanvas = el('canvas', { class: 'colorbar-canvas' })
    this.readout = el('div', { class: 'readout', text: '' })
    this.titleNode = el('h2', { class: 'panel-title', text: '' })
    this.overlay = el('div', { class: 'panel-overlay hidden' })

    this.heatmap = new HeatmapView(this.canvas, {
      // Contig labels are drawn only below the Python threshold; above it they
      // would be a grey smear rather than information (`ops/show.py`).
      maxLabels: MAX_CATEGORICAL_TICKS,
      // Gutters are measured from the labels themselves: real contig names run
      // to `NODE_7431_len_134871`, which no fixed margin fits, and a genome with
      // too many contigs to label should not reserve a gutter at all.
      autoMargin: true,
      onChange: () => this.schedule(),
      onHover: (cell) => this.describe(cell),
      onCellClick: (cell) => this.emitClick(cell),
    })
    this.heatmap.attach()
    this.colorbar = new ColorbarView(this.barCanvas, { caption: 'count' })

    const transformSelect = el('select', { class: 'select' })
    for (const name of TRANSFORMS) transformSelect.appendChild(el('option', { value: name, text: name }))
    transformSelect.value = this.transform
    transformSelect.addEventListener('change', () => {
      this.transform = transformSelect.value as Transform
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

    this.autoVmax = el('input', { class: 'checkbox', type: 'checkbox' })
    this.autoVmax.checked = this.manualVmax === undefined
    this.autoVmax.addEventListener('change', () => {
      this.manualVmax = this.autoVmax.checked ? undefined : this.heatmap.effectiveScale.vmax
      this.vmaxInput.disabled = this.autoVmax.checked
      if (this.manualVmax !== undefined) this.vmaxInput.value = String(this.manualVmax)
      this.rescale()
    })

    this.vmaxInput = el('input', { class: 'input input-num', type: 'number' })
    this.vmaxInput.disabled = this.manualVmax === undefined
    if (this.manualVmax !== undefined) this.vmaxInput.value = String(this.manualVmax)
    this.vmaxInput.addEventListener('change', () => {
      const parsed = Number(this.vmaxInput.value)
      this.manualVmax = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
      this.autoVmax.checked = this.manualVmax === undefined
      this.rescale()
    })

    const controls: HTMLElement[] = [
      field('transform', transformSelect, 'Value transform, matching `metacooler show --transform`.'),
      field('colormap', colormapSelect, 'afmhot_r is the CLI default (§7.1).'),
      field('auto vmax', this.autoVmax, '99th percentile of the non-zero transformed values (§7.1).'),
      field('vmax', this.vmaxInput),
      button('reset view', () => this.heatmap.fit(), { title: 'Fit the block to the canvas (key: 0)' }),
    ]

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

    const wrap = el('div', { class: 'heatmap-wrap' }, this.canvas, this.overlay)

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
      el(
        'header',
        { class: 'panel-head' },
        this.titleNode,
        ...(options.detachedControls === true ? [] : [this.controlsEl]),
      ),
      body,
      this.readout,
    )

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

  /** Release the resize observer and the canvas listeners. */
  destroy(): void {
    this.observer?.disconnect()
    this.heatmap.detach()
    if (this.frame !== 0) cancelAnimationFrame(this.frame)
  }

  /** Load a block. `HeatmapView` refits and recomputes the auto vmax (§7.1). */
  setData(data: MatrixResult, title: string): void {
    this.data = data
    this.titleNode.textContent = title
    this.heatmap.setMatrix(toDense(data), separatorsFor(data))
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
   * The colour scale as configured. `vmax` is `NaN` in auto mode, which is how
   * {@link HeatmapView} is asked for the `metacooler show` default.
   */
  scale(): ColorScale {
    return {
      vmin: 0,
      vmax: this.manualVmax ?? Number.NaN,
      transform: this.transform,
      colormap: this.colormap,
    }
  }

  private rescale(): void {
    this.heatmap.setScale(this.scale())
    this.options.onScaleChange?.({
      transform: this.transform,
      colormap: this.colormap,
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
      const effective = this.heatmap.effectiveScale
      this.colorbar.setScale(effective)
      this.colorbar.draw()
      if (this.autoVmax.checked && Number.isFinite(effective.vmax)) {
        this.vmaxInput.value = effective.vmax.toPrecision(4)
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

  private describe(cell: Cell | null): void {
    if (cell === null || this.data === null) {
      this.readout.textContent = ''
      return
    }
    const data = this.data
    const rowGroup = groupAt(data.rowGroups, cell.row)
    const colGroup = groupAt(data.colGroups, cell.col)
    this.readout.textContent =
      `${describeAxis(rowGroup, cell.row, data.level, this.options.binsize)}  ×  ` +
      `${describeAxis(colGroup, cell.col, data.level, this.options.binsize)}   ` +
      `count ${fmt.num(cell.value)}`
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
 * One side of the hover readout. At bin level the position inside the contig is
 * exact arithmetic from the bin size (§3.3) — `/bins` is never consulted.
 */
function describeAxis(
  group: AxisGroup | undefined,
  offset: number,
  level: 'bin' | 'contig' | 'genome',
  binsize: number,
): string {
  if (group === undefined) return '—'
  if (level !== 'bin') return group.label
  return `${group.label}:${fmt.bp((offset - group.start) * binsize)}`
}

/** Separator positions: the first row/column of every group after the first. */
export function separatorsFor(data: MatrixResult): SeparatorSet {
  const toSeparators = (groups: AxisGroup[]): Separator[] =>
    groups.map((group) => ({ at: group.start, label: group.label }))
  return { rows: toSeparators(data.rowGroups), cols: toSeparators(data.colGroups) }
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

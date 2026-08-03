/**
 * The genome-pair view (spec §5.3) — a first-class destination, not a mode.
 *
 * This is the rectangular off-diagonal block between two genomes: the
 * phage–host, plasmid–host and HGT view, and the thing no existing browser
 * does. Both genomes are one contiguous bin range under constraint C4, so it is
 * one bounded query.
 *
 * **Transpose handling lives in the reader**, and it is mandatory: storage is
 * upper-triangular (`bin1_id ≤ bin2_id`), so when the column genome precedes
 * the row genome in bin space the block must be queried transposed and flipped.
 * Get it wrong and every inter-genome panel comes back blank — the app's most
 * distinctive feature failing silently. This view therefore renders whatever
 * orientation it asked for and reports both axes explicitly, so a blank panel is
 * legible as "no contacts" rather than as "wrong query".
 */

import type { MatrixResult } from '../worker/protocol'
import type { ReaderClient } from '../worker/client'
import { button, el, field, fmt } from './dom'
import type { ScaleState } from './GenomeView'
import { MatrixPanel, axisRegion } from './MatrixPanel'

export interface PairViewProps {
  client: ReaderClient
  binsize: number
  /** Selectable genomes — `__unbinned__` is not among them (§7.4). */
  genomeNames: string[]
  rowGenome: string
  colGenome: string
  level: 'bin' | 'contig'
  scale: ScaleState
  balance: boolean
  hasWeights: boolean
  onBalanceChange(balance: boolean): void
  onChangeGenomes(rowGenome: string, colGenome: string): void
  onLevelChange(level: 'bin' | 'contig'): void
  onScaleChange(scale: ScaleState): void
  onOpenGenome(genome: string): void
  /**
   * A contig named on one of the axes, opened by clicking its label — or the
   * block between one contig of each genome, selected by drawing on it.
   */
  onOpenContig(contig: string, contig2?: string): void
  onError(err: unknown): void
  /** File and genome context for the exported figure's caption. */
  caption?: { file: string; genome?: string }
}

export class PairView {
  readonly el: HTMLElement
  /**
   * The view's own controls, mounted by the shell in the right-hand column
   * rather than inside this element — see `App.showContent`.
   */
  readonly sideEl: HTMLElement
  private readonly panel: MatrixPanel
  private readonly summary: HTMLElement
  private level: 'bin' | 'contig'
  private disposed = false

  constructor(private readonly props: PairViewProps) {
    this.level = props.level
    this.summary = el('p', { class: 'summary' })

    const rowSelect = this.genomeSelect(props.rowGenome, (value) =>
      props.onChangeGenomes(value, props.colGenome),
    )
    const colSelect = this.genomeSelect(props.colGenome, (value) =>
      props.onChangeGenomes(props.rowGenome, value),
    )
    const swap = button('swap axes', () => props.onChangeGenomes(props.colGenome, props.rowGenome), {
      title: 'Exchange the row and column genomes. The stored triangle is unaffected — the reader transposes.',
    })

    this.panel = new MatrixPanel({
      binsize: props.binsize,
      ...(props.caption === undefined ? {} : { caption: props.caption }),
      levels: ['bin', 'contig'],
      // The same shape as the genome and region views: the heading names the
      // selection, the controls live in the sidebar, and the panel draws only
      // the plot. A pair is a view of this file like any other.
      detachedControls: true,
      hideTitle: true,
      initial: { ...props.scale, level: props.level },
      balance: props.balance,
      offerBalance: props.hasWeights,
      onBalanceChange: (balance) => props.onBalanceChange(balance),
      onScaleChange: (scale) => props.onScaleChange(scale),
      onLevelChange: (level) => {
        this.level = level
        props.onLevelChange(level)
        void this.load()
      },
      // The axes here are the two genomes' contigs, so a label names a contig
      // rather than either genome — the genomes are named in the heading, and
      // in the two buttons beside the plot.
      onLabelClick: (_axis, name) => props.onOpenContig(name),
      // The axes are the two genomes' contigs, so a box names one contig of
      // each — and the block between them is exactly what a pair view is for.
      onSelectRegion: (selection) =>
        selection.diagonal
          ? props.onOpenContig(axisRegion(selection.rows))
          : props.onOpenContig(axisRegion(selection.rows), axisRegion(selection.cols)),
    })

    this.el = el(
      'section',
      { class: 'view view-pair' },
      el(
        'header',
        { class: 'view-head' },
        el(
          'div',
          { class: 'title-bar' },
          el('h2', { text: `${props.rowGenome} × ${props.colGenome}` }),
        ),
        this.summary,
      ),
      this.panel.el,
    )

    this.sideEl = el(
      'aside',
      { class: 'side' },
      this.panel.controlsEl,
      this.panel.plotEl,
      el(
        'section',
        { class: 'card' },
        el('h3', { text: 'Pair' }),
        el(
          'div',
          { class: 'pair-controls' },
          field('rows', rowSelect),
          field('columns', colSelect),
          swap,
          button('open rows genome →', () => props.onOpenGenome(props.rowGenome), {
            class: 'btn btn-quiet',
          }),
        ),
      ),
    )

    void this.load()
  }

  /**
   * Adopt a colour scale the URL moved to (a shared link, the back button).
   *
   * Delegated to the panel, which repaints without echoing the change back out.
   * Its existence is what lets `App.render` treat a colour-only state change as
   * a repaint rather than as a reason to rebuild this view and re-read its
   * matrix.
   */
  applyScale(scale: ScaleState): void {
    this.panel.applyScale(scale)
  }

  destroy(): void {
    this.disposed = true
    this.panel.destroy()
  }

  private genomeSelect(selected: string, onChange: (value: string) => void): HTMLSelectElement {
    const select = el('select', { class: 'select select-wide' })
    for (const name of this.props.genomeNames) {
      select.appendChild(el('option', { value: name, text: name }))
    }
    select.value = selected
    select.addEventListener('change', () => onChange(select.value))
    return select
  }

  private async load(): Promise<void> {
    this.panel.setBusy(true)
    try {
      const [rows, cols] = await Promise.all([
        this.props.client.request<'range'>({ kind: 'range', range: this.props.rowGenome }),
        this.props.client.request<'range'>({ kind: 'range', range: this.props.colGenome }),
      ])
      const query = { rows: rows.extent, cols: cols.extent, balance: this.props.balance }
      const result: MatrixResult =
        this.level === 'bin'
          ? await this.props.client.request<'matrix'>({ kind: 'matrix', ...query })
          : await this.props.client.request<'aggregate'>({ kind: 'aggregate', ...query, level: 'contig' })
      if (this.disposed) return
      this.panel.setData(result, `${this.props.rowGenome} × ${this.props.colGenome}`)
      this.renderSummary(result)
    } catch (err) {
      this.props.onError(err)
    }
  }

  private renderSummary(result: MatrixResult): void {
    let sum = 0
    let nonZero = 0
    for (let i = 0; i < result.values.length; i++) {
      const value = result.values[i]
      // A NaN cell is a dropped bin, not a contact: counting it would report a
      // pair as busy because its rows were filtered out.
      if (value !== 0 && !Number.isNaN(value)) {
        sum += value
        nonZero++
      }
    }
    const cells = result.nrows * result.ncols
    this.summary.textContent =
      `${fmt.int(result.nrows)} × ${fmt.int(result.ncols)} ${result.level}s · ` +
      `${fmt.int(nonZero)} non-zero cells (${fmt.pct(cells === 0 ? 0 : nonZero / cells)}) · ` +
      `total signal ${fmt.num(sum)}` +
      (nonZero === 0 ? ' — these two genomes share no contacts in this file.' : '')
  }
}

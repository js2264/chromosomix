/**
 * The genome view (spec §5.2): one MAG's full intra-genome matrix.
 *
 * The matrix is loaded whole, in one bounded read, and held in memory — that is
 * the §2 assumption the whole architecture rests on. Everything after the load
 * is local: pan, zoom, the colour scale, and the bin ↔ contig level toggle,
 * which is a sum over data that is already here rather than a second query.
 */

import type { ParsedRange, Transform } from '../types'
import type { MatrixResult } from '../worker/protocol'
import type { ReaderClient } from '../worker/client'
import { el, fmt } from './dom'
import { MatrixPanel } from './MatrixPanel'
import { stepper } from './Stepper'

/** The colour-scale fields that are carried in the URL hash (§5.5). */
export interface ScaleState {
  transform?: Transform
  colormap?: string
  /** Colour-scale clip in transformed units; absent means auto (§7.1). */
  vmin?: number
  vmax?: number
}

export interface GenomeViewProps {
  client: ReaderClient
  binsize: number
  genome: string
  level: 'bin' | 'contig'
  scale: ScaleState
  balance: boolean
  hasWeights: boolean
  onBalanceChange(balance: boolean): void
  onLevelChange(level: 'bin' | 'contig'): void
  onScaleChange(scale: ScaleState): void
  onOpenRegion(region: string): void
  /**
   * Two contigs were named by one click on their intersection — the caller
   * opens the rectangular block between them rather than either one's square.
   */
  onOpenContigPair(rowContig: string, colContig: string): void
  onError(err: unknown): void
  /** Genomes one step away in display order, for the `‹ ›` buttons. */
  neighbours?: { prev: string | null; next: string | null }
  onStep?(delta: number): void
}

export class GenomeView {
  readonly el: HTMLElement
  private readonly panel: MatrixPanel
  private readonly summary: HTMLElement
  private readonly contigList: HTMLElement
  private readonly contigBox: HTMLElement
  private readonly note: HTMLElement
  private extent: [number, number] | null = null
  private level: 'bin' | 'contig'
  private disposed = false

  constructor(private readonly props: GenomeViewProps) {
    this.level = props.level
    this.summary = el('p', { class: 'summary' })
    this.note = el('p', { class: 'note hidden' })
    this.contigList = el('div', { class: 'contig-list' })

    this.panel = new MatrixPanel({
      binsize: props.binsize,
      levels: ['bin', 'contig'],
      // The controls live in this view's sidebar, stacked above the contig list,
      // and the `<h2>` above already names the genome.
      detachedControls: true,
      hideTitle: true,
      initial: { ...props.scale, level: props.level },
      balance: props.balance,
      offerBalance: props.hasWeights,
      onBalanceChange: (balance) => props.onBalanceChange(balance),
      onScaleChange: (scale) => props.onScaleChange(scale),
      onLevelChange: (level) => {
        this.level = level
        this.contigBox?.classList.toggle('hidden', level === 'contig')
        props.onLevelChange(level)
        void this.load()
      },
      onCellClick: (_cell, groups) => {
        if (groups.row === undefined) return
        // §5.5: an off-diagonal cell *is* the relationship between two contigs,
        // so it opens the rectangular block between them. Opening either
        // contig's own square map instead would answer a question the click did
        // not ask, and would silently discard the other axis.
        if (groups.col !== undefined && groups.col.label !== groups.row.label) {
          props.onOpenContigPair(groups.row.label, groups.col.label)
          return
        }
        props.onOpenRegion(groups.row.label)
      },
    })

    // At contig level every cell already *is* a contig, labelled on both axes,
    // so the list underneath would repeat the picture rather than add to it.
    this.contigBox = el(
      'section',
      { class: 'card contig-box' },
      el('h3', { text: 'Contigs' }),
      this.contigList,
    )
    this.contigBox.classList.toggle('hidden', this.level === 'contig')

    this.el = el(
      'section',
      { class: 'view view-genome' },
      el(
        'header',
        { class: 'view-head' },
        el(
          'div',
          { class: 'title-bar' },
          el('h2', { text: props.genome }),
          ...(props.neighbours === undefined || props.onStep === undefined
            ? []
            : [stepper({ neighbours: props.neighbours, onStep: props.onStep, noun: 'genome' })]),
        ),
        this.summary,
        this.note,
      ),
      el(
        'div',
        { class: 'genome-body' },
        this.panel.el,
        el('aside', { class: 'side' }, this.panel.controlsEl, this.panel.plotEl, this.contigBox),
      ),
    )

    void this.load()
  }

  destroy(): void {
    this.disposed = true
    this.panel.destroy()
  }

  private async load(): Promise<void> {
    this.panel.setBusy(true)
    try {
      if (this.extent === null) {
        const range: ParsedRange = await this.props.client.request<'range'>({
          kind: 'range',
          range: this.props.genome,
        })
        this.extent = range.extent
      }
      const [lo, hi] = this.extent
      const result: MatrixResult =
        this.level === 'bin'
          ? await this.props.client.request<'matrix'>({ kind: 'matrix', rows: [lo, hi] })
          : await this.props.client.request<'aggregate'>({
              kind: 'aggregate',
              rows: [lo, hi],
              level: 'contig',
            })
      if (this.disposed) return
      this.panel.setData(result, `${this.props.genome} — ${this.level} level`)
      this.renderSummary(result, hi - lo)
      this.renderContigs(result)
    } catch (err) {
      this.props.onError(err)
    }
  }

  private renderSummary(result: MatrixResult, bins: number): void {
    const contigs = result.level === 'bin' ? result.rowGroups.length : result.nrows
    this.summary.textContent =
      `${fmt.int(bins)} bins across ${fmt.int(contigs)} contigs · ` +
      `${fmt.int(result.nrows)} × ${fmt.int(result.ncols)} cells rendered · ` +
      `pan and zoom are local — no further reads.`
  }

  private renderContigs(result: MatrixResult): void {
    this.contigList.replaceChildren()
    for (const group of result.rowGroups) {
      const size = result.level === 'bin' ? `${fmt.int(group.end - group.start)} bins` : ''
      const item = el(
        'button',
        { class: 'contig-item', type: 'button', title: group.label },
        el('span', { class: 'contig-name', text: group.label }),
        el('span', { class: 'contig-size', text: size }),
      )
      item.addEventListener('click', () => this.props.onOpenRegion(group.label))
      this.contigList.appendChild(item)
    }
  }
}

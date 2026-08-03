/**
 * The genome-wide view: the entire matrix, in one bounded read.
 *
 * SPECS §9 used to rule this out for cool files, on the grounds that a
 * eukaryotic cooler reintroduces the streaming problem §2 exists to avoid. That
 * is true of a *human* cooler and false of the genomes this viewer is most
 * often pointed at: yeast is 12 Mb, which at 1 kb is 12,100 bins — one bounded
 * read, about 600 MB on screen, and the single most useful picture of the file.
 *
 * So the size question is asked rather than assumed. `readDenseMatrix`
 * estimates what the block will cost from its cell count and the file's own
 * `nnz` and refuses only if the estimate does not fit this machine; when it
 * does not, contig level always does, and it is one click away in the same
 * view.
 */

import type { MatrixResult } from '../worker/protocol'
import type { ReaderClient } from '../worker/client'
import { ViewerError } from '../errors'
import { button, el, fmt } from './dom'
import type { ScaleState } from './GenomeView'
import { MatrixPanel, axisRegion, poolingNote } from './MatrixPanel'

export interface WholeViewProps {
  client: ReaderClient
  binsize: number
  /** Total bins — the whole matrix is `[0, nBins)` on both axes. */
  nBins: number
  level: 'bin' | 'contig'
  scale: ScaleState
  balance: boolean
  /** Whether the file carries a weight column at all. */
  hasWeights: boolean
  /**
   * Offer the bin ↔ contig roll-up. Off for a cooler: there the unit is a
   * chromosome, one file often holds one of them, and "contig level" on a
   * single-genome file is a picture of a single cell.
   */
  offerLevel: boolean
  /** What one axis unit is called here: a chromosome, or a contig. */
  noun: string
  /**
   * Ask the reader which genome each contig belongs to, for the tooltip.
   *
   * This is the one view where the answer is not already known from the view
   * itself: a genome view is one genome and a region view is one contig of one,
   * but here the axes run over the whole file and a contig's genome is exactly
   * the thing that is not on screen. False for a plain cooler, which has none.
   */
  namesGenomes: boolean
  onLevelChange(level: 'bin' | 'contig'): void
  onBalanceChange(balance: boolean): void
  onScaleChange(scale: ScaleState): void
  /** A cell was clicked: open that sequence, or the block between two. */
  onOpenRegion(region: string, region2?: string): void
  onError(err: unknown): void
  /** File and genome context for the exported figure's caption. */
  caption?: { file: string; genome?: string }
}

export class WholeView {
  readonly el: HTMLElement
  /**
   * The view's own controls, mounted by the shell in the right-hand column
   * rather than inside this element — see `App.showContent`.
   */
  readonly sideEl: HTMLElement
  private readonly panel: MatrixPanel
  private readonly summary: HTMLElement
  private readonly problem: HTMLElement
  private level: 'bin' | 'contig'
  private disposed = false

  constructor(private readonly props: WholeViewProps) {
    this.level = props.level
    this.summary = el('p', { class: 'summary' })
    this.problem = el('p', { class: 'inline-error hidden' })

    this.panel = new MatrixPanel({
      binsize: props.binsize,
      ...(props.caption === undefined ? {} : { caption: props.caption }),
      ...(props.offerLevel
        ? {
            levels: ['bin', 'contig'] as Array<'bin' | 'contig'>,
            levelLabels: { contig: props.noun },
          }
        : {}),
      detachedControls: true,
      hideTitle: true,
      initial: { ...props.scale, level: props.level },
      balance: props.balance,
      offerBalance: props.hasWeights,
      onScaleChange: (scale) => props.onScaleChange(scale),
      onBalanceChange: (balance) => props.onBalanceChange(balance),
      onLevelChange: (level) => {
        this.level = level
        props.onLevelChange(level)
        void this.load()
      },
      onCellClick: (_cell, groups) => {
        if (groups.row === undefined) return
        if (groups.col !== undefined && groups.col.label !== groups.row.label) {
          props.onOpenRegion(groups.row.label, groups.col.label)
          return
        }
        props.onOpenRegion(groups.row.label)
      },
      onLabelClick: (_axis, name) => props.onOpenRegion(name),
      // On the diagonal a box is one region; anywhere else it is the rectangle
      // between two windows — of two chromosomes in the trans corner, or of one
      // chromosome against itself above its own diagonal, which is a picture
      // this view can show and a single region cannot.
      onSelectRegion: (selection) =>
        selection.diagonal
          ? props.onOpenRegion(axisRegion(selection.rows))
          : props.onOpenRegion(axisRegion(selection.rows), axisRegion(selection.cols)),
    })

    this.el = el(
      'section',
      { class: 'view view-whole' },
      el(
        'header',
        { class: 'view-head' },
        el('div', { class: 'title-bar' }, el('h2', { text: 'Whole genome' })),
        this.summary,
        this.problem,
      ),
      this.panel.el,
    )

    this.sideEl = el('aside', { class: 'side' }, this.panel.controlsEl, this.panel.plotEl)

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

  private async load(budgetBytes?: number): Promise<void> {
    const { client, nBins, balance, noun, namesGenomes } = this.props
    const rows: [number, number] = [0, nBins]
    const budget = budgetBytes === undefined ? {} : { budgetBytes }
    const genomes = namesGenomes ? { genomes: true } : {}
    this.panel.setBusy(true)
    this.problem.replaceChildren()
    this.problem.classList.add('hidden')
    try {
      const result: MatrixResult =
        this.level === 'bin'
          ? await client.request<'matrix'>({ kind: 'matrix', rows, balance, ...budget, ...genomes })
          : await client.request<'aggregate'>({
              kind: 'aggregate',
              rows,
              level: 'contig',
              balance,
              ...budget,
              ...genomes,
            })
      if (this.disposed) return
      this.panel.setData(result, 'Whole genome')
      const pooled = this.level === 'bin' ? poolingNote(result.nrows, result.ncols) : null
      this.summary.textContent =
        `${fmt.int(nBins)} bins across ${fmt.int(result.rowGroups.length)} ${noun}s · ` +
        `${fmt.int(result.nrows)} × ${fmt.int(result.ncols)} cells` +
        (pooled === null ? ' · 1 bin is 1 pixel' : ` · ${pooled.phrase}`) +
        (balance ? ' · balanced' : '')
    } catch (err) {
      // Too big is a fact about this machine, not a broken file: say it here,
      // above a level control that offers the version which does fit, rather
      // than on an error screen that offers a way back to the file picker.
      if (err instanceof ViewerError && err.code === 'dense-too-large') {
        this.panel.setBusy(false)
        // Only the *browser* refusal is overridable. The CLI-parity limit and a
        // real allocation failure are not opinions about this machine.
        const estimate = err.detail['bytes']
        const needed =
          err.detail['where'] === 'browser' && typeof estimate === 'number' ? estimate : null
        // "Switch to level" is a real escape hatch now. It used to be a false
        // one: the roll-up loaded the same bin-level block before summing it, so
        // it was refused by the same guard for the same reason. It accumulates
        // from the stored pixels instead, and its cost is the *output* size —
        // one cell per sequence pair, which always fits.
        this.problem.replaceChildren(
          el('span', {
            text:
              `${err.message} The ${noun}-level view of the same selection is one cell per ` +
              `${noun} and always fits; a coarser resolution of this file, if it has one, or a ` +
              `single ${noun} from the table, will too.`,
          }),
          // The budget is a guess from a property Chromium caps at 8 and the
          // other two engines do not implement at all, so it says the same thing
          // about a workstation as about a laptop and nothing about a Mac. When
          // it refuses a block the user is often the one who knows better, and
          // this is how they say so.
          ...(needed === null
            ? []
            : [
                button(`load anyway (${fmt.bytes(needed)})`, () => void this.load(needed), {
                  class: 'btn',
                  title:
                    'Ignore the estimated memory budget for this read. The tab may become ' +
                    'unresponsive while the block loads, and may run out of memory.',
                }),
              ]),
        )
        this.problem.classList.remove('hidden')
        this.summary.textContent = ''
        return
      }
      this.props.onError(err)
    }
  }
}

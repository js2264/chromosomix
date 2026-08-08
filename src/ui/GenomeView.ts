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
import { cardTitle } from './icons'
import { MatrixPanel, axisRegion, blockSummary, poolingNote,
  type DerivePresentation,
  type TurnPresentation,
} from './MatrixPanel'
import { scoreChoices, scoreFor, type ScoreChoice } from './scores'
import { SearchBox } from './SearchBox'
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
  /**
   * The `/pixels` column the reads take; `count` when absent.
   *
   * Resolved by the session rather than derived here from {@link score}, so the
   * fallback for a hash naming a column this file does not have is decided in
   * one place — see `Session.valueOf`.
   */
  value?: string
  /** Value columns this file carries, for the score picker (`ui/scores.ts`). */
  scoreColumns?: readonly string[]
  /** The picker's current choice, by id; `count` when absent. */
  score?: string
  onScoreChange(choice: ScoreChoice): void
  /**
   * The derived-values presentation (`render/derive.ts`), built by the session.
   *
   * Passed through rather than assembled here: four views mount the same panel,
   * and a default decided in each is a default that comes to differ.
   */
  derive?: DerivePresentation
  /** The 45° turn (`render/rotate.ts`), built by the session like `derive`. */
  turn?: TurnPresentation
  onLevelChange(level: 'bin' | 'contig'): void
  onScaleChange(scale: ScaleState): void
  onOpenRegion(region: string): void
  /**
   * Two contigs were named by one click on their intersection — the caller
   * opens the rectangular block between them rather than either one's square.
   */
  onOpenContigPair(rowContig: string, colContig: string): void
  onError(err: unknown): void
  /** File and genome context for the exported figure's caption. */
  caption?: { file: string; genome?: string }
  /** Genomes one step away in display order, for the `‹ ›` buttons. */
  neighbours?: { prev: string | null; next: string | null }
  onStep?(delta: number): void
}

export class GenomeView {
  readonly el: HTMLElement
  /**
   * The view's own controls, mounted by the shell in the right-hand column
   * rather than inside this element — see `App.showContent`.
   */
  readonly sideEl: HTMLElement
  /**
   * The heatmap panel, exposed so the shell can reach it.
   *
   * The manual-annotation card lives in the sidebar and the plot lives in
   * whichever view is mounted, so "click the map to place a mark" has to cross
   * that gap. The shell forwards to this; the view itself stays unaware.
   */
  readonly panel: MatrixPanel
  private readonly summary: HTMLElement
  /** Where a contig is typed; the `/` key puts the caret here. */
  private readonly search: SearchBox
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
    this.search = new SearchBox({
      placeholder: 'contig, or contig:start-end',
      title: 'Open one contig of this genome, or a range within it.',
      onSubmit: (text) => {
        if (text !== '') props.onOpenRegion(text)
      },
    })
    this.contigList = el('div', { class: 'contig-list' })

    this.panel = new MatrixPanel({
      binsize: props.binsize,
      ...(props.caption === undefined ? {} : { caption: props.caption }),
      levels: ['bin', 'contig'],
      // The controls live in this view's sidebar, stacked above the contig list,
      // and the `<h2>` above already names the genome.
      detachedControls: true,
      hideTitle: true,
      initial: { ...props.scale, level: props.level },
      balance: props.balance,
      ...(props.derive === undefined ? {} : { derive: props.derive }),
      ...(props.turn === undefined ? {} : { turn: props.turn }),
      scores: {
        choices: scoreChoices(props),
        current: scoreFor(scoreChoices(props), props).id,
        onChange: (choice) => props.onScoreChange(choice),
      },
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
      // A label names one contig and nothing else — there is no second axis in
      // it — so it opens that contig, whichever edge it was clicked on.
      onLabelClick: (_axis, name) => props.onOpenRegion(name),
      // The same rule as a click on an off-diagonal cell (§5.5): the block
      // between two contigs, not one of them.
      onSelectRegion: (selection) =>
        selection.diagonal
          ? props.onOpenRegion(axisRegion(selection.rows))
          : props.onOpenContigPair(axisRegion(selection.rows), axisRegion(selection.cols)),
    })

    // At contig level every cell already *is* a contig, labelled on both axes,
    // so the list underneath would repeat the picture rather than add to it.
    this.contigBox = el(
      'section',
      { class: 'card contig-box' },
      cardTitle('Contigs', 'list'),
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
          this.search.el,
        ),
        this.summary,
        this.note,
      ),
      this.panel.el,
    )

    this.sideEl = el(
      'aside',
      { class: 'side' },
      ...this.panel.cards,
      this.contigBox,
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

  /** The `/` key. */
  focusSearch(): void {
    this.search.focus()
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
      // The reader plans the grid for a genome, because it is the side that
      // knows how many contigs are in one (`worker/reader.worker.ts`). A cell of
      // six bins is a six-bin bin, and every coordinate on screen is that
      // multiplication — so the panel is told before it is given the block.
      this.panel.setResolution(this.props.binsize * (result.binsPerCell ?? 1))
      this.panel.setData(result, this.props.genome)
      this.renderSummary(result)
      this.renderContigs(result)
    } catch (err) {
      // A view that has been torn down must not navigate the shell. Closing the
      // map puts the reader down, which rejects every read still in flight —
      // and a rejection arriving after the browser has been mounted in this
      // view's place would replace it with an error screen about a worker
      // nobody is waiting for.
      if (this.disposed) return
      this.props.onError(err)
    }
  }

  private renderSummary(result: MatrixResult): void {
    const pooled = result.level === 'bin' ? poolingNote(result.nrows, result.ncols) : null
    this.summary.replaceChildren(
      ...blockSummary(this.props.binsize, result, 'contig'),
      ...(pooled === null ? [] : [` · ${pooled.phrase}`]),
      ' · ',
      this.panel.viewNote,
    )
  }




  private renderContigs(result: MatrixResult): void {
    this.contigList.replaceChildren()
    const binsize = Math.max(1, this.props.binsize)
    for (const group of result.rowGroups) {
      // Every sequence, not every cell. Where the small ones share a cell the
      // axis is labelled with the first of them, and listing the labels listed
      // one contig in two — so the list is built from what the cells *hold*.
      const members =
        group.merged ?? [{ label: group.label, unitLength: group.unitLength ?? 0 }]
      for (const { label, unitLength } of members) {
        // The sequence's own bins, from its own length — not `end - start`,
        // which counts the *cells* it is drawn in and reads "1 bins" for a
        // contig of two the moment two of them share a pixel.
        const bins = unitLength > 0 ? Math.max(1, Math.ceil(unitLength / binsize)) : 0
        const item = el(
          'button',
          {
            class: members.length > 1 ? 'contig-item is-shared' : 'contig-item',
            type: 'button',
            title:
              members.length > 1
                ? `${label} — drawn in a cell it shares with ${fmt.int(members.length - 1)} other ` +
                  `${members.length === 2 ? 'sequence' : 'sequences'}`
                : label,
          },
          el('span', { class: 'contig-name', text: label }),
          el('span', {
            class: 'contig-size',
            text: result.level === 'bin' && bins > 0 ? `${fmt.int(bins)} bins` : '',
          }),
        )
        item.addEventListener('click', () => this.props.onOpenRegion(label))
        this.contigList.appendChild(item)
      }
    }
  }


}

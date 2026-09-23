/**
 * The genome view (spec §5.2): one MAG's full intra-genome matrix.
 *
 * The matrix is loaded whole, in one bounded read, and held in memory — that is
 * the §2 assumption the whole architecture rests on. Everything after the load
 * is local: pan, zoom and the colour scale. The bin ↔ contig level is chosen
 * in the General column's Contigs card (`Session.paintLevel`) and comes back as
 * a view built at it; this genome's contigs are listed, and ticked, there too.
 */

import type { ParsedRange, Transform } from '../types'
import type { MatrixResult } from '../worker/protocol'
import type { ReaderClient } from '../worker/client'
import { el } from './dom'
import { MatrixPanel, axisRegion, blockSummary, poolingNote,
  type AnnotationContext,
  type DerivePresentation,
  type TurnPresentation,
} from './MatrixPanel'
import { scoreChoices, scoreFor, type ScoreChoice } from './scores'
import { attachRefine, rungsOf, type BlockLadder } from './refine'
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
  /** Sibling rungs of a laddered file (§3.4); absent for a plain one. */
  rungs?: readonly string[]
  /**
   * Bins of this map summed into one drawn cell, because the reader asked for a
   * resolution the file does not store (§3.4).
   *
   * The factor, not the bin size: a 10 kb rung derived from a 2 kb map is `5`,
   * and the effective resolution on screen is this map's bin size times it. The
   * base rung is the map that is *open* — picking a derived resolution navigates
   * to it — so every read here is an ordinary one carrying an explicit plan,
   * and the worker snaps that plan to each sequence's own grid so the cells hold
   * the same sums wherever the reader pans (`worker/reader.worker.ts`).
   *
   * Absent, or 1, is every view of every file until somebody adds one.
   */
  binsPerCell?: number
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
  onScaleChange(scale: ScaleState): void
  onOpenRegion(region: string): void
  /**
   * Two contigs were named by one click on their intersection — the caller
   * opens the rectangular block between them rather than either one's square.
   */
  onOpenContigPair(rowContig: string, colContig: string): void
  onError(err: unknown): void
  /**
   * Annotations to draw beside the map (§8, §8.12).
   *
   * On a metagenome this is the file's *own* columns and nothing else: a
   * `.metacool` loads no annotation files at all (§8.5), and its `/genomes` and
   * `/contigs` tables are indexed against this very axis. Which is why this view
   * — reachable only on a file that has genomes — takes the context now, when it
   * never used to.
   */
  annotations?: AnnotationContext
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
  private readonly note: HTMLElement
  private extent: [number, number] | null = null
  private level: 'bin' | 'contig'
  private disposed = false
  /**
   * The zoom's own reader. Its ceiling is this genome, which is also the
   * block it starts from: a genome view already reads the whole of what it
   * is a view of, so there is nowhere further out to go and zooming out
   * costs nothing but a swap back to the block already held.
   */
  private ladder: BlockLadder | null = null

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

    this.panel = new MatrixPanel({
      binsize: props.binsize,
      ...(props.caption === undefined ? {} : { caption: props.caption }),
      ...(props.annotations === undefined ? {} : { annotations: props.annotations }),
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
    this.ladder?.destroy()
    this.ladder = null
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
          ? await this.props.client.request<'matrix'>({
              kind: 'matrix',
              rows: [lo, hi],
              ...this.pooled(),
            })
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
      this.armRefine([lo, hi], result)
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

  /**
   * Let the zoom read inside this genome.
   *
   * Only at bin level: a contig-level block's cells *are* sequences, so there is
   * no finer grid for a zoom to reach and the roll-up is a different question
   * from the one this answers. That is also the rule `MatrixPanel.refineWindow`
   * enforces on its own side, and it is stated in both places because a ladder
   * armed on a rolled-up view would sit there being asked and answering nothing.
   */
  private armRefine(ceiling: [number, number], result: MatrixResult): void {
    this.ladder?.destroy()
    this.ladder = null
    if (this.level !== 'bin') return
    this.ladder = attachRefine({
      panel: this.panel,
      ceiling: { rows: ceiling, cols: ceiling },
      binsize: this.props.binsize,
      rungs: rungsOf(this.props.rungs ?? []),
      // The grid the reader declared (§3.4), so a zoom cannot quietly read past
      // the resolution the axis is labelled with.
      floor: () => this.props.binsPerCell ?? 1,
      read: (rows, cols, rung, binsPerCell) => {
        const own = this.props.client.cancellable<'matrix'>({
          kind: 'matrix',
          ...(rung === undefined ? {} : { rung }),
          ...(binsPerCell === undefined ? {} : { binsPerCell }),
          rows,
          cols,
        })
        return { cancel: own.cancel, promise: own.promise.then((block) => ({ result: block })) }
      },
      onInstalled: (block) => this.renderSummary(block),
    })
    this.ladder.adopt(result)
  }

  /**
   * `{ binsPerCell }` where the reader declared a resolution, else nothing.
   *
   * Absent rather than `1` on the ordinary path: `1` is a plan, and absent is
   * *choose one* — which is what a genome-wide read has always relied on, since
   * the side that knows how many contigs are in a genome is the reader.
   */
  private pooled(): { binsPerCell?: number } {
    const k = this.props.binsPerCell ?? 1
    return k > 1 ? { binsPerCell: k } : {}
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






}

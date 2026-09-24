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
import { button, el, field, titleWhenCut } from './dom'
import type { ScaleState } from './GenomeView'
import { cardTitle } from './icons'
import { MatrixPanel, axisRegion, blockSummary,
  type AnnotationContext,
  type DerivePresentation,
  type TurnPresentation,
} from './MatrixPanel'
import { scoreChoices, scoreFor, type ScoreChoice } from './scores'
import { attachRefine, rungsOf, type BlockLadder } from './refine'
import { typedLocusToRegion } from '../genome/assembly'
import { SearchBox, locusPlaceholder } from './SearchBox'

export interface PairViewProps {
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
  /** Selectable genomes — `__unbinned__` is not among them (§7.4). */
  genomeNames: string[]
  rowGenome: string
  colGenome: string
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
  onChangeGenomes(rowGenome: string, colGenome: string): void
  onScaleChange(scale: ScaleState): void
  onOpenGenome(genome: string): void
  /**
   * A contig named on one of the axes, opened by clicking its label — or the
   * block between one contig of each genome, selected by drawing on it.
   */
  onOpenContig(contig: string, contig2?: string): void
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
}

export class PairView {
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
  private level: 'bin' | 'contig'
  private disposed = false
  /**
   * The zoom's own reader. The two axes have separate ceilings — the two
   * genomes — because a pair is a rectangle and its two sides are
   * independent, which is the same reason the two ranges are resolved
   * separately above.
   */
  private ladder: BlockLadder | null = null

  constructor(private readonly props: PairViewProps) {
    this.level = props.level
    this.summary = el('p', { class: 'summary' })
    // One line under the title, with the whole of it in a tooltip where it is cut.
    titleWhenCut(this.summary)
    this.search = new SearchBox({
      // The shared builder and the shared `go` (§26.6): this box asked for the
      // same thing as the five others in its own phrasing, and had no button.
      placeholder: locusPlaceholder({ accepts: { sequence: true } }),
      go: true,
      title:
        'Open one contig of either genome, or a range within it. Coordinates are 1-based and ' +
        'inclusive, as IGV and samtools write them.',
      // 1-based inclusive in, the machine form out (§26.1).
      onSubmit: (text) => {
        if (text !== '') props.onOpenContig(typedLocusToRegion(text))
      },
    })

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
      ...(props.annotations === undefined ? {} : { annotations: props.annotations }),
      // The same shape as the genome and region views: the heading names the
      // selection, the controls live in the sidebar, and the panel draws only
      // the plot. A pair is a view of this file like any other.
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
          this.search.el,
        ),
        this.summary,
      ),
      this.panel.el,
    )

    this.sideEl = el(
      'aside',
      { class: 'side' },
      ...this.panel.cards,
      el(
        'section',
        { class: 'card' },
        cardTitle('Pair', 'columns-2'),
        el(
          'div',
          { class: 'pair-controls' },
          field('rows', rowSelect),
          field('columns', colSelect),
          swap,
          // **Both genomes, each named.** There was one door and it was labelled
          // `open rows genome →`, which is not a phrase and does not say which
          // genome it opens — and a phage–host reader wants the host's own map as
          // often as the phage's, which meant swapping the axes to get at it
          // (§5.3). Bordered, like every other action (§26.4): a door to another
          // view is not a quieter thing than the picker above it.
          button(`open ${props.rowGenome} →`, () => props.onOpenGenome(props.rowGenome)),
          button(`open ${props.colGenome} →`, () => props.onOpenGenome(props.colGenome)),
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

  private genomeSelect(selected: string, onChange: (value: string) => void): HTMLSelectElement {
    const select = el('select', { class: 'select select-wide' })
    for (const name of this.props.genomeNames) {
      select.appendChild(el('option', { value: name, text: name }))
    }
    select.value = selected
    select.addEventListener('change', () => onChange(select.value))
    return select
  }

  /** Let the zoom read inside the pair; bin level only, as everywhere. */
  private armRefine(
    rowCeiling: [number, number],
    colCeiling: [number, number],
    result: MatrixResult,
  ): void {
    this.ladder?.destroy()
    this.ladder = null
    if (this.level !== 'bin') return
    this.ladder = attachRefine({
      panel: this.panel,
      ceiling: { rows: rowCeiling, cols: colCeiling },
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
          balance: this.props.balance,
          ...(this.props.value === undefined ? {} : { value: this.props.value }),
        })
        return { cancel: own.cancel, promise: own.promise.then((block) => ({ result: block })) }
      },
      onInstalled: (block) => this.renderSummary(block),
    })
    this.ladder.adopt(result)
  }

  private async load(): Promise<void> {
    this.panel.setBusy(true)
    try {
      const [rows, cols] = await Promise.all([
        this.props.client.request<'range'>({ kind: 'range', range: this.props.rowGenome }),
        this.props.client.request<'range'>({ kind: 'range', range: this.props.colGenome }),
      ])
      const query = {
        rows: rows.extent,
        cols: cols.extent,
        balance: this.props.balance,
        ...(this.props.value === undefined ? {} : { value: this.props.value }),
      }
      // The declared grid on the bin-level read alone: a contig-level roll-up's
      // cells *are* sequences, and there is no bin size to hold it to.
      const pooled =
        (this.props.binsPerCell ?? 1) > 1 ? { binsPerCell: this.props.binsPerCell } : {}
      const result: MatrixResult =
        this.level === 'bin'
          ? await this.props.client.request<'matrix'>({ kind: 'matrix', ...query, ...pooled })
          : await this.props.client.request<'aggregate'>({ kind: 'aggregate', ...query, level: 'contig' })
      if (this.disposed) return
      // The reader may have planned a coarser grid than the file's bins — a
      // whole chromosome at 10 kb is more cells than any picture holds — and
      // every coordinate on screen is the bin size times a cell offset, so the
      // panel is told before it is given the block.
      this.panel.setResolution(this.props.binsize * (result.binsPerCell ?? 1))
      this.panel.setData(result, `${this.props.rowGenome} × ${this.props.colGenome}`)
      this.renderSummary(result)
      this.armRefine(rows.extent, cols.extent, result)
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
    let nonZero = 0
    for (let i = 0; i < result.values.length; i++) {
      const value = result.values[i]
      // A NaN cell is a dropped bin, not a contact: counting it would report a
      // pair as busy because its rows were filtered out.
      if (value !== 0 && !Number.isNaN(value)) nonZero++
    }
    // The same line every other map carries, plus the one thing a genome pair
    // can say that they cannot: that the two never touch in this file. An empty
    // square is otherwise indistinguishable from one that failed to load.
    this.summary.replaceChildren(
      ...blockSummary(this.props.binsize, result, 'contig'),
      ' · ',
      this.panel.viewNote,
      ...(nonZero === 0 ? [' — these two genomes share no contacts in this file.'] : []),
    )
  }

}

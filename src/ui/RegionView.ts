/**
 * The region view (spec §5.4): a `contig` or `contig:start-end` selection.
 *
 * Range parsing is not done here — it is delegated to the reader so that the
 * browser and `parse_metacooler_range` agree exactly, including the refusals:
 *
 * 1. a **genome name** expands to the whole-genome extent, and a coordinate
 *    suffix on a genome name is an *error*, not something quietly ignored;
 * 2. otherwise a **contig**, optionally with coordinates (0-based, half-open —
 *    cooler's convention, verified against `parse_region`);
 * 3. neither → an error listing the available genomes and contigs.
 *
 * Genome and contig namespaces can collide and genome wins, as in Python, so
 * the view states which kind the search matched rather than leaving the user to
 * infer it from the picture.
 *
 * With a second region set, the block is the **rectangle between two contigs**
 * rather than one contig's square. That is what clicking the intersection of two
 * contigs in a genome view asks for, and the two axes are independent: the row
 * range and the column range are resolved separately and the reader handles the
 * transpose when the column range precedes the row range in bin space (§5.3).
 */

import type { ParsedRange } from '../types'
import type { MatrixResult } from '../worker/protocol'
import { ViewerError } from '../errors'
import type { ReaderClient } from '../worker/client'
import { button, el, fmt } from './dom'
import type { ScaleState } from './GenomeView'
import { MatrixPanel, axisRegion } from './MatrixPanel'
import { stepper } from './Stepper'

export interface RegionViewProps {
  client: ReaderClient
  binsize: number
  region: string
  /** Column-axis region; when set the block is rectangular, not square. */
  region2?: string
  scale: ScaleState
  balance: boolean
  /** Whether the file carries a weight column at all. */
  hasWeights: boolean
  /** What one sequence is called here: a contig, or a chromosome. */
  noun: string
  onBalanceChange(balance: boolean): void
  /**
   * A new selection. The second region makes the block rectangular — the
   * contacts *between* two contigs rather than within one (§5.3).
   */
  onChangeRegion(region: string, region2?: string): void
  onScaleChange(scale: ScaleState): void
  onOpenGenome(genome: string): void
  onError(err: unknown): void
  /** File and genome context for the exported figure's caption. */
  caption?: { file: string; genome?: string }
  /**
   * Contigs one step away in file order. Absent for a two-contig block, which
   * has two axes and so no single neighbour to step to.
   */
  neighbours?: { prev: string | null; next: string | null }
  onStep?(delta: number): void
}

export class RegionView {
  readonly el: HTMLElement
  /**
   * The view's own controls, mounted by the shell in the right-hand column
   * rather than inside this element — see `App.showContent`.
   */
  readonly sideEl: HTMLElement
  private readonly panel: MatrixPanel
  private readonly input: HTMLInputElement
  private readonly matched: HTMLElement
  private readonly title: HTMLElement
  private readonly problem: HTMLElement
  private disposed = false

  constructor(private readonly props: RegionViewProps) {
    this.input = el('input', {
      class: 'input input-region',
      type: 'text',
      value: props.region,
      placeholder: 'contig, contig:start-end, or a genome name',
    })
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') props.onChangeRegion(this.input.value.trim())
    })
    this.matched = el('span', { class: 'match-kind' })
    this.problem = el('p', { class: 'inline-error hidden' })

    this.panel = new MatrixPanel({
      binsize: props.binsize,
      ...(props.caption === undefined ? {} : { caption: props.caption }),
      initial: props.scale,
      // Same shape as the genome view: heading names the selection, controls
      // live in the sidebar. Only the Contigs card is missing, because inside a
      // single contig there is no list to offer.
      detachedControls: true,
      hideTitle: true,
      balance: props.balance,
      offerBalance: props.hasWeights,
      onBalanceChange: (balance) => props.onBalanceChange(balance),
      onScaleChange: (scale) => props.onScaleChange(scale),
      onCellClick: (_cell, groups) => {
        if (groups.row !== undefined && groups.row.label !== props.region) {
          props.onChangeRegion(groups.row.label)
        }
      },
      // On a contig × contig block the two axes are different contigs, and the
      // label is how you drop the other one: click the row name to open that
      // contig by itself.
      onLabelClick: (_axis, name) => {
        if (name !== props.region) props.onChangeRegion(name)
      },
      // Narrowing by drawing: the same view over a smaller range on the
      // diagonal, and the rectangle between the two windows anywhere else —
      // including above the diagonal of a single contig, which is where the
      // long-range structure of that contig lives.
      onSelectRegion: (selection) =>
        selection.diagonal
          ? props.onChangeRegion(axisRegion(selection.rows))
          : props.onChangeRegion(axisRegion(selection.rows), axisRegion(selection.cols)),
    })

    // The heading *is* the region, as the genome view's heading is the genome;
    // a literal "Region" above a box that already says which one was a line
    // spent on the obvious.
    this.title = el('h2', { class: 'region-title', text: props.region })

    this.el = el(
      'section',
      { class: 'view view-region' },
      el(
        'header',
        { class: 'view-head' },
        // `.title-bar`, the same wrapper every other view heading uses — the
        // region box rides on the title line rather than in a row of its own,
        // because it *is* the title: typing in it is how you change what this
        // view is of.
        el(
          'div',
          { class: 'title-bar region-bar' },
          this.title,
          ...(props.neighbours === undefined || props.onStep === undefined
            ? []
            : [stepper({ neighbours: props.neighbours, onStep: props.onStep, noun: props.noun })]),
          this.input,
          button('go', () => props.onChangeRegion(this.input.value.trim())),
          // Back, beside the box that got you here. Every navigation is a
          // history entry (§5.5 puts the whole view state in the hash), so this
          // is the browser's own back — the same button the keyboard and the
          // trackpad already reach, put where a selection lands you. Selecting
          // a box now *opens* something, and undoing that should not require
          // knowing where you were.
          button('← back', () => window.history.back(), {
            class: 'btn btn-quiet',
            title: 'Back to the previous view',
          }),
        ),
        this.matched,
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

  private async load(): Promise<void> {
    if (this.props.region === '') return
    this.panel.setBusy(true)
    this.problem.classList.add('hidden')
    try {
      const parsed: ParsedRange = await this.props.client.request<'range'>({
        kind: 'range',
        range: this.props.region,
      })
      const [lo, hi] = parsed.extent

      if (this.props.region2 === undefined) {
        const result: MatrixResult = await this.props.client.request<'matrix'>({
          kind: 'matrix',
          rows: [lo, hi],
          balance: this.props.balance,
        })
        if (this.disposed) return
        this.title.textContent = this.props.region
        this.describeMatch(parsed, hi - lo)
        this.panel.setData(result, this.props.region)
        return
      }

      const other: ParsedRange = await this.props.client.request<'range'>({
        kind: 'range',
        range: this.props.region2,
      })
      const [lo2, hi2] = other.extent
      const result: MatrixResult = await this.props.client.request<'matrix'>({
        kind: 'matrix',
        rows: [lo, hi],
        cols: [lo2, hi2],
        balance: this.props.balance,
      })
      if (this.disposed) return
      this.title.textContent = `${this.props.region} × ${this.props.region2}`
      this.describePair(parsed, other)
      this.panel.setData(result, `${this.props.region} × ${this.props.region2}`)
    } catch (err) {
      // A bad range is a normal, recoverable typing mistake: keep the view and
      // its input, and report the reader's own wording inline. Anything else is
      // a real failure and belongs on the error screen.
      // `dense-too-large` belongs here too: on a cooler, clicking a chromosome
      // in the table is a one-click way to ask for a block no tab can draw, and
      // the answer is a sentence above an intact region box — type a window and
      // carry on — not a full-screen error with a "go back" button.
      if (
        err instanceof ViewerError &&
        (err.code === 'unknown-label' ||
          err.code === 'genome-coordinate-suffix' ||
          err.code === 'unbinned-not-displayable' ||
          err.code === 'dense-too-large')
      ) {
        this.panel.setBusy(false)
        this.problem.textContent = err.message
        this.problem.classList.remove('hidden')
        this.matched.textContent = ''
        return
      }
      this.props.onError(err)
    }
  }

  /** The readout for a rectangular two-contig block. */
  private describePair(row: ParsedRange, col: ParsedRange): void {
    const rowBins = row.extent[1] - row.extent[0]
    const colBins = col.extent[1] - col.extent[0]
    this.matched.classList.remove('is-genome')
    this.matched.replaceChildren(
      `${row.label} × ${col.label} · ${fmt.int(rowBins)} × ${fmt.int(colBins)} bins · ` +
        'contacts between the two contigs',
    )
  }

  private describeMatch(parsed: ParsedRange, bins: number): void {
    const kind = parsed.kind === 'genome' ? 'genome' : this.props.noun
    this.matched.textContent = `matched ${kind} ${parsed.label} · ${fmt.int(bins)} bins · bins ${fmt.int(parsed.extent[0])}–${fmt.int(parsed.extent[1] - 1)}`
    this.matched.classList.toggle('is-genome', parsed.kind === 'genome')
    if (parsed.kind === 'genome') {
      const open = button('open genome view →', () => this.props.onOpenGenome(parsed.label), {
        class: 'btn btn-quiet',
      })
      this.matched.replaceChildren(this.matched.textContent ?? '', open)
    }
  }
}

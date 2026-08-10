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
import { button, el } from './dom'
import type { ScaleState } from './GenomeView'
import {
  MatrixPanel,
  axisRegion,
  blockSummary,
  type AnnotationContext,
  type DerivePresentation,
  type TurnPresentation,
} from './MatrixPanel'
import { presentationOf, secondBlock, type CompareRead } from './compare'
import { attachRefine, rungsOf, type BlockLadder } from './refine'
import { scoreChoices, scoreFor, type ScoreChoice } from './scores'
import { SearchBox, featureSuggestions } from './SearchBox'
import { stepper } from './Stepper'

export interface RegionViewProps {
  client: ReaderClient
  binsize: number
  /** Sibling rungs of a laddered file (§3.4); absent for a plain one. */
  rungs?: readonly string[]
  /**
   * A control the session puts on the title line, after the box.
   *
   * The 1D/2D switch, today. An element rather than a callback because what
   * it says depends on which of the two pictures is on screen, and only the
   * session knows that — see `Session.mapToggleButton`.
   */
  extraControl?: HTMLElement
  region: string
  /** Column-axis region; when set the block is rectangular, not square. */
  region2?: string
  scale: ScaleState
  balance: boolean
  /** Whether the file carries a weight column at all. */
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
  /** What one sequence is called here: a contig, or a chromosome. */
  noun: string
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
  /**
   * A new selection. The second region makes the block rectangular — the
   * contacts *between* two contigs rather than within one (§5.3).
   */
  onChangeRegion(region: string, region2?: string): void
  onScaleChange(scale: ScaleState): void
  onOpenGenome(genome: string): void
  onError(err: unknown): void
  /**
   * Annotations to draw beside and on the map (spec §8).
   *
   * Supplied only for a cooler; a `.metacool` never carries one (§8.5), which is
   * why the genome and pair views — reachable only on files that *have* genomes
   * — do not take this at all.
   */
  annotations?: AnnotationContext
  /**
   * A second cooler in the lower-left triangle (`render/compare.ts`).
   *
   * The same block, read from the other file. The two agree about contigs and
   * bin size — the compare gate is what establishes that — so the extents
   * resolved for this file address the same bins in the other one, and nothing
   * has to be parsed twice.
   */
  compare?: CompareRead
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
  /**
   * The heatmap panel, exposed so the shell can reach it.
   *
   * The manual-annotation card lives in the sidebar and the plot lives in
   * whichever view is mounted, so "click the map to place a mark" has to cross
   * that gap. The shell forwards to this; the view itself stays unaware.
   */
  readonly panel: MatrixPanel
  private readonly search: SearchBox
  private readonly matched: HTMLElement
  private readonly title: HTMLElement
  private readonly problem: HTMLElement
  private disposed = false
  /**
   * The zoom's own reader, once a block is on screen.
   *
   * Built after the first read rather than in the constructor, because it
   * needs the ceiling — and the ceiling is the *whole sequence* this region
   * is a window into, which is the one thing a region view knows and the
   * other views do not. A genome view already reads its whole genome, so
   * there is nowhere further out for it to go; a region is a window, and
   * zooming out of a window should reach the rest of what it is a window on.
   */
  private ladder: BlockLadder | null = null

  constructor(private readonly props: RegionViewProps) {
    const store = props.annotations?.store
    this.search = new SearchBox({
      inputClass: 'input-region',
      value: props.region,
      placeholder:
        store === undefined
          ? 'contig, contig:start-end, or a genome name'
          : 'contig, contig:start-end, a genome, or a gene',
      title:
        'What this view is of. Type a contig or a range and press Enter' +
        (store === undefined ? '.' : ', or a gene name from the starred model.'),
      onSubmit: (text) => props.onChangeRegion(text),
      // Only where there is something to search. A map with no gene model
      // loaded would grow a list that never has anything in it.
      ...(store === undefined
        ? {}
        : { suggest: (text: string) => featureSuggestions(store, text) }),
    })
    this.matched = el('span', { class: 'match-kind' })
    this.problem = el('p', { class: 'inline-error hidden' })

    this.panel = new MatrixPanel({
      binsize: props.binsize,
      ...(props.caption === undefined ? {} : { caption: props.caption }),
      ...(props.annotations === undefined ? {} : { annotations: props.annotations }),
      ...(presentationOf(props.compare) === undefined
        ? {}
        : { compare: presentationOf(props.compare) }),
      initial: props.scale,
      // Same shape as the genome view: heading names the selection, controls
      // live in the sidebar. Only the Contigs card is missing, because inside a
      // single contig there is no list to offer.
      detachedControls: true,
      hideTitle: true,
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
          this.search.el,
          // Through the box rather than around it: Enter and this button mean the
          // same thing, and a hit list the button could not see would make them
          // disagree about what "go" is.
          button('go', () => this.search.submit()),
          ...(props.extraControl === undefined ? [] : [props.extraControl]),
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

    this.sideEl = el('aside', { class: 'side' }, ...this.panel.cards)

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

  /** The `/` key: this view's box is the region box, which is also its title. */
  focusSearch(): void {
    this.search.focus()
  }

  destroy(): void {
    this.disposed = true
    this.ladder?.destroy()
    this.ladder = null
    this.panel.destroy()
  }

  /**
   * Let the zoom read, now that there is a picture to zoom into.
   *
   * The ceiling is the **whole sequence** each axis is a window on, not the
   * window itself: a region is the one view that is a viewport onto something
   * bigger, so zooming out of it should reach the rest of the chromosome rather
   * than stop at the edge of whatever was typed in the box. It costs one `range`
   * request per axis, which reads no pixels — `parsed.contig` names the sequence
   * and the reader answers with its bin extent from `chrom_offset` arithmetic
   * (§4).
   *
   * Rebuilt per load, because a navigation is a different window on a possibly
   * different sequence, and a ladder holding the last one would hand back blocks
   * of somewhere else.
   */
  private async armRefine(
    rows: ParsedRange,
    result: MatrixResult,
    cols: ParsedRange | undefined,
  ): Promise<void> {
    this.ladder?.destroy()
    this.ladder = null
    const ceiling = await this.wholeOf(rows, cols)
    if (this.disposed || ceiling === null) return
    const query = (rowExtent: [number, number], colExtent: [number, number], rung?: string) => ({
      kind: 'matrix' as const,
      ...(rung === undefined ? {} : { rung }),
      rows: rowExtent,
      ...(cols === undefined ? {} : { cols: colExtent }),
      balance: this.props.balance,
      ...(this.props.value === undefined ? {} : { value: this.props.value }),
    })
    this.ladder = attachRefine({
      panel: this.panel,
      ceiling,
      binsize: this.props.binsize,
      rungs: rungsOf(this.props.rungs ?? []),
      read: (rowExtent, colExtent, rung) => {
        const own = this.props.client.cancellable<'matrix'>(query(rowExtent, colExtent, rung))
        return {
          cancel: own.cancel,
          promise: own.promise.then(async (block) => {
            const second = await secondBlock(this.props.compare, (client) =>
              client.request<'matrix'>(query(rowExtent, colExtent, rung)),
            )
            return second === undefined ? { result: block } : { result: block, second }
          }),
        }
      },
      onInstalled: (block) => {
        if (cols === undefined) this.describeMatch(rows, block)
        else this.describePair(block)
      },
      onError: (err) => {
        // Said once, in the line the region box already reports into, and not
        // per frame: `BlockLadder` remembers a refusal so the same read is not
        // reissued, and this is the sentence that goes with it.
        this.problem.textContent = err instanceof Error ? err.message : String(err)
        this.problem.classList.remove('hidden')
      },
    })
    this.ladder.adopt(result)
  }

  /**
   * The bin extent of the whole sequence each axis is a window on.
   *
   * `null` where an axis is not a window on a single sequence — a range that
   * names several, or one the reader has since navigated away from — and the
   * zoom then simply does not read, which is today's behaviour and is never
   * wrong, only less.
   */
  private async wholeOf(
    rows: ParsedRange,
    cols: ParsedRange | undefined,
  ): Promise<{ rows: [number, number]; cols: [number, number] } | null> {
    const whole = async (range: ParsedRange): Promise<[number, number] | null> => {
      // A genome range is already whole — `metacooler` refuses coordinates on
      // one (§10) — so its own extent is the ceiling and there is nothing to ask.
      if (range.kind === 'genome') return range.extent
      try {
        const full: ParsedRange = await this.props.client.request<'range'>({
          kind: 'range',
          range: range.label,
        })
        return full.extent
      } catch {
        return null
      }
    }
    const rowCeiling = await whole(rows)
    if (rowCeiling === null) return null
    if (cols === undefined) return { rows: rowCeiling, cols: rowCeiling }
    const colCeiling = await whole(cols)
    return colCeiling === null ? null : { rows: rowCeiling, cols: colCeiling }
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
          ...(this.props.value === undefined ? {} : { value: this.props.value }),
        })
        const second = await secondBlock(this.props.compare, (client) =>
          client.request<'matrix'>({
            kind: 'matrix',
            rows: [lo, hi],
            balance: this.props.balance,
            ...(this.props.value === undefined ? {} : { value: this.props.value }),
          }),
        )
        if (this.disposed) return
        this.title.textContent = this.props.region
        this.describeMatch(parsed, result)
        // The reader may have planned a coarser grid than the file's bins — a
        // whole chromosome at 10 kb is more cells than any picture holds — and
        // every coordinate on screen is the bin size times a cell offset, so the
        // panel is told before it is given the block.
        this.panel.setResolution(this.props.binsize * (result.binsPerCell ?? 1))
        this.panel.setData(result, this.props.region, second)
        await this.armRefine(parsed, result, undefined)
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
        ...(this.props.value === undefined ? {} : { value: this.props.value }),
      })
      const second = await secondBlock(this.props.compare, (client) =>
        client.request<'matrix'>({
          kind: 'matrix',
          rows: [lo, hi],
          cols: [lo2, hi2],
          balance: this.props.balance,
          ...(this.props.value === undefined ? {} : { value: this.props.value }),
        }),
      )
      if (this.disposed) return
      this.title.textContent = `${this.props.region} × ${this.props.region2}`
      this.describePair(result)
      // The reader may have planned a coarser grid than the file's bins — a
      // whole chromosome at 10 kb is more cells than any picture holds — and
      // every coordinate on screen is the bin size times a cell offset, so the
      // panel is told before it is given the block.
      this.panel.setResolution(this.props.binsize * (result.binsPerCell ?? 1))
      this.panel.setData(result, `${this.props.region} × ${this.props.region2}`, second)
      await this.armRefine(parsed, result, other)
    } catch (err) {
      // A view that has been torn down must not navigate the shell. Closing the
      // map puts the reader down, which rejects every read still in flight —
      // and a rejection arriving after the browser has been mounted in this
      // view's place would replace it with an error screen about a worker
      // nobody is waiting for.
      if (this.disposed) return
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

  /** The readout for a rectangular block between two ranges. */
  private describePair(result: MatrixResult): void {
    this.matched.classList.remove('is-genome')
    this.matched.replaceChildren(...blockSummary(this.props.binsize, result), ' · ', this.panel.viewNote)
  }

  private describeMatch(parsed: ParsedRange, result: MatrixResult): void {
    this.matched.classList.toggle('is-genome', parsed.kind === 'genome')
    const parts = blockSummary(this.props.binsize, result)
    // The one part of the line that moves, and last, so a pan changes only the
    // tail of it — see `MatrixPanel.viewNote`.
    parts.push(' · ', this.panel.viewNote)
    if (parsed.kind === 'genome') {
      parts.push(
        button('open genome view →', () => this.props.onOpenGenome(parsed.label), {
          class: 'btn btn-quiet',
        }),
      )
    }
    this.matched.replaceChildren(...parts)
  }

}

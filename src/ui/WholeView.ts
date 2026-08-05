/**
 * The genome-wide view: the whole matrix, at whatever resolution it can be
 * drawn at.
 *
 * SPECS §9 used to rule this out for cool files, on the grounds that a
 * eukaryotic cooler reintroduces the streaming problem §2 exists to avoid. That
 * is true of a *human* cooler and false of the genomes this viewer is most
 * often pointed at: yeast is 12 Mb, which at 1 kb is 12,100 bins and the single
 * most useful picture of the file.
 *
 * It used to ask for that picture one file bin per cell, and there is a size
 * past which that cannot be done at all: the values are one `Float32Array`, a
 * browser serves at most 2 GiB in one, and a whole yeast genome at 500 bp is
 * 24,228 bins and 2.3 GB. It was offered, computed, and then refused — for a
 * block nothing was going to show, since the renderer pools any raster to
 * `RASTER_MAX_DIM` per axis and 24,228 rows were always going to be drawn as
 * about 4,000 pixels.
 *
 * So the block is read **at the resolution it will be drawn at**
 * (`metacooler/pooling.ts`): every `stride` consecutive bins of a chromosome
 * summed into one cell, in the worker, from the stored pixels. The read is
 * bounded at 4096² cells whatever the file's bin count, so this view no longer
 * has a size that defeats it — and because the stride restarts at each
 * chromosome, what arrives is an ordinary block one bin size up. The panel is
 * told that bin size and every coordinate, tick, tooltip and selection is right
 * without knowing pooling happened.
 *
 * What it costs is the pass over the stored pixels, which is the same pass it
 * always cost and is what {@link WHOLE_VIEW_GATE_PIXELS} asks about first. The
 * whole-metagenome scan is gated for that reason and this is now gated for the
 * same one; the shell keeps whichever of the two it built, so coming back is
 * free.
 */

import { WHOLE_VIEW_GATE_PIXELS } from '../constants'
import { POOLED_CELL_CAP, poolStride } from '../metacooler/pooling'
import type { MatrixResult } from '../worker/protocol'
import { isCancellation, type Cancellable, type ReaderClient } from '../worker/client'
import { ViewerError } from '../errors'
import { button, el, fmt } from './dom'
import type { ScaleState } from './GenomeView'
import { MatrixPanel, axisRegion, poolingNote, type AnnotationContext } from './MatrixPanel'
import { presentationOf, secondBlock, type CompareRead } from './compare'
import { SearchBox } from './SearchBox'

export interface WholeViewProps {
  client: ReaderClient
  binsize: number
  /** Total bins — the whole matrix is `[0, nBins)` on both axes. */
  nBins: number
  /**
   * Stored pixels in the file, when it says. The read walks all of them, so
   * this is what it costs and what the gate asks about; `null` where the file
   * declares no `nnz`, and then nothing is asked.
   */
  nnz: number | null
  /**
   * The sequences to draw, when it is not all of them.
   *
   * A selection and the whole file are the same picture asked for two ways —
   * this view is "the map of what you chose", and choosing everything is what
   * it did before there was a way to choose less. So it is one class: the
   * selection changes which read is made and what the heading says, and nothing
   * else about the view knows.
   */
  selection?: { kind: 'genome' | 'contig'; names: string[]; bins: number }
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
   * Read with the same request, after the first — sequentially rather than in
   * parallel, because both are full passes over their file's pixels and running
   * two at once would double the peak memory of the operation this view already
   * asks permission for.
   */
  compare?: CompareRead
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
  /**
   * The heatmap panel, exposed so the shell can reach it.
   *
   * The manual-annotation card lives in the sidebar and the plot lives in
   * whichever view is mounted, so "click the map to place a mark" has to cross
   * that gap. The shell forwards to this; the view itself stays unaware.
   */
  readonly panel: MatrixPanel
  private readonly summary: HTMLElement
  private readonly problem: HTMLElement
  /** Where a contig or a range is typed; the `/` key puts the caret here. */
  private readonly search: SearchBox
  /** The ask-first screen, and the map it stands in front of. */
  private readonly gate: HTMLElement
  private readonly panelHost: HTMLElement
  /**
   * Fixed for the life of this view: the level is view state, and the shell
   * builds one of these per level rather than asking it to change its mind.
   */
  private readonly level: 'bin' | 'contig'
  /**
   * Bins summed into one cell: `1` at contig level, where a cell is a whole
   * sequence, and at bin level whatever brings the axes down to what the
   * renderer draws.
   *
   * Decided here rather than in the worker because the panel has to be built
   * with the matching bin size *before* the read returns — a cell of six 500 bp
   * bins is a 3 kb bin, and every coordinate on screen is that multiplication.
   */
  private readonly stride: number
  /** The bar, the count and the cancel — the whole-metagenome scan's, verbatim. */
  private readonly progressBar = el('progress', { class: 'progress' })
  private readonly progressText = el('span', { class: 'progress-text' })
  private readonly progressBox: HTMLElement
  /** The read in flight, so it can be called off. */
  private running: Cancellable<MatrixResult> | null = null
  private disposed = false

  constructor(private readonly props: WholeViewProps) {
    this.level = props.level
    // A selection is pooled against *its own* size: four MAGs are a small
    // picture however large the file they came out of is, and pooling them by
    // the file's stride would throw away the detail they were chosen for.
    this.stride =
      props.level === 'bin'
        ? poolStride(props.selection?.bins ?? props.nBins, POOLED_CELL_CAP)
        : 1
    this.summary = el('p', { class: 'summary' })
    this.problem = el('p', { class: 'inline-error hidden' })
    this.search = new SearchBox({
      placeholder: `${props.noun}, or ${props.noun}:start-end`,
      title: `Open one ${props.noun}, or a range within it. The same box the / key opens.`,
      onSubmit: (text) => {
        if (text !== '') props.onOpenRegion(text)
      },
    })
    this.gate = el('div', { class: 'gate hidden' })
    this.progressBar.max = 1
    this.progressBox = el(
      'div',
      { class: 'progress-box hidden' },
      this.progressBar,
      this.progressText,
      button('cancel', () => this.cancel(), { class: 'btn btn-quiet' }),
    )
    this.panelHost = el('div', { class: 'whole-host' })

    this.panel = new MatrixPanel({
      // The bin size of the grid actually on screen. Pooling is not a mode the
      // panel has to know about: a block of 3 kb cells is a block of 3 kb bins.
      binsize: props.binsize * this.stride,
      ...(props.caption === undefined ? {} : { caption: props.caption }),
      ...(props.annotations === undefined ? {} : { annotations: props.annotations }),
      ...(presentationOf(props.compare) === undefined
        ? {}
        : { compare: presentationOf(props.compare) }),
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
      // Reported, not acted on. Both of these change *what is read*, so they go
      // out to the URL and the shell brings back a view built for the answer —
      // which is also what decides whether the new read is one to ask about
      // first. Loading here as well was the second of two reads for one click.
      onLevelChange: (level) => props.onLevelChange(level),
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

    this.panelHost.appendChild(this.panel.el)
    this.el = el(
      'section',
      { class: 'view view-whole' },
      el(
        'header',
        { class: 'view-head' },
        el(
          'div',
          { class: 'title-bar' },
          el('h2', { text: this.heading() }),
          // The box `/` reaches, and the only way to leave this picture by
          // typing rather than by aiming: a whole-genome map of a mammal is
          // three pixels per chromosome arm, so "go to MYC" is a question this
          // view has to be able to answer without a click on a 3-pixel target.
          this.search.el,
        ),
        this.summary,
        this.problem,
      ),
      this.gate,
      this.progressBox,
      this.panelHost,
    )

    this.sideEl = el('aside', { class: 'side' }, this.panel.controlsEl, this.panel.plotEl)

    // There is no longer a size that defeats this view, so there are two
    // answers rather than three: this is worth asking about first, or it opens.
    if (this.gatePixels() === null) void this.load()
    else this.renderGate()
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
    this.running?.cancel()
    this.running = null
    this.panel.destroy()
  }

  /**
   * Call the read off and go back to the gate.
   *
   * Cancellation is cooperative and therefore late — the worker stops at the
   * next window — so what makes it *look* immediate is putting the gate back
   * now. A result that arrives afterwards is dropped by {@link running} having
   * been cleared, the same way the overview's generation counter drops one.
   */
  private cancel(): void {
    this.running?.cancel()
    this.running = null
    this.progressBox.classList.add('hidden')
    this.panelHost.classList.add('hidden')
    this.panel.setBusy(false)
    this.renderGate()
  }

  /**
   * The pixels this read will walk, when there are enough of them to ask about
   * first, and `null` when there are not.
   *
   * The cost of both levels is the same pass over the same pixels — the roll-up
   * and the pooled read differ only in what they add them into — so the question
   * is asked at either. What is no longer asked is anything about the *block*:
   * it is bounded now, and a bounded block is not a decision.
   */
  private gatePixels(): number | null {
    const { nnz } = this.props
    if (nnz === null || nnz <= WHOLE_VIEW_GATE_PIXELS) return null
    return nnz
  }

  /**
   * The ask-first screen: what the read costs, and the button that starts it.
   *
   * Stated in pixels and in the resolution they will be summed into, because
   * those are the two things a reader cannot see from here and would want:
   * how long this will take, and what the picture will be. The metagenome's
   * gate says the same two things in its own units.
   */
  private renderGate(): void {
    const pixels = this.gatePixels()
    if (pixels === null) return
    this.gate.replaceChildren(
      el('p', {
        text:
          `This reads every stored pixel of the file — ${fmt.int(pixels)} of them — and sums ` +
          `them into ${this.resolutionPhrase()}. It runs once: the picture is kept for as long ` +
          'as the file is open.' +
          // A selection reads the whole file too: the sequences it wants are
          // scattered through the pixels, so there is no smaller span to walk.
          // Saying so is the difference between a wait that makes sense and one
          // that looks like a bug.
          (this.props.selection === undefined
            ? ''
            : ' A selection costs the same pass: its sequences are spread through the file, so ' +
              'there is no shorter way to find them.'),
      }),
      button('compute whole genome', () => this.compute(), { class: 'btn' }),
    )
    this.gate.classList.remove('hidden')
    this.panelHost.classList.add('hidden')
  }

  /** The gate was accepted. */
  private compute(): void {
    void this.load(Number.POSITIVE_INFINITY)
  }

  /**
   * What this view is of: everything, or the sequences that were ticked.
   *
   * Named rather than counted while there are few enough to read — `II × VII`
   * is the picture, and "2 chromosomes" is a fact about it.
   */
  private heading(): string {
    const selection = this.props.selection
    if (selection === undefined) return 'Whole genome'
    const noun = selection.kind === 'genome' ? 'genomes' : `${this.props.noun}s`
    return selection.names.length <= 3
      ? selection.names.join(' × ')
      : `${fmt.int(selection.names.length)} ${noun}`
  }

  /**
   * `3.0 kb cells (6 bins each)`, or `500 bp cells` where nothing is summed.
   *
   * Takes the stride rather than reading it, so the summary can state the one
   * the read *reports* while the gate states the one it is about to ask for. The
   * two agree, and the point of saying so from the result is that a picture and
   * the sentence over it can then never claim two different resolutions.
   */
  private resolutionPhrase(stride = this.stride): string {
    const size = this.props.binsize * stride
    return stride === 1 ? `${fmt.bp(size)} cells` : `${fmt.bp(size)} cells (${stride} bins each)`
  }

  private async load(budgetBytes?: number): Promise<void> {
    const { client, nBins, balance, namesGenomes } = this.props
    const rows: [number, number] = [0, nBins]
    const budget = budgetBytes === undefined ? {} : { budgetBytes }
    const genomes = namesGenomes ? { genomes: true } : {}
    // Whatever stood in front of the map — the gate, or a refusal that has just
    // been overridden — this is the read it was waiting for.
    this.gate.classList.add('hidden')
    this.panelHost.classList.remove('hidden')
    this.panel.setBusy(true)
    this.problem.replaceChildren()
    this.problem.classList.add('hidden')
    this.progressBar.value = 0
    this.progressText.textContent = 'starting…'
    this.progressBox.classList.remove('hidden')

    // Cancellable, and watched, because it is the same pass over every pixel the
    // whole-metagenome scan makes — see `metacooler/matrix.ts`. The task is held
    // so `cancel` can reach it and so a result that arrives *after* a cancel can
    // be told apart from the one being waited for.
    const onProgress = (done: number, total: number): void => {
      this.progressBar.value = total === 0 ? 0 : done / total
      this.progressText.textContent = `${fmt.int(done)} of ${fmt.int(total)} pixels`
    }
    // Three kinds, one shape: each resolves to a `MatrixResult` and each walks
    // the same pixels. Written as separate calls rather than one over a union
    // because a request type is a discriminated union and narrowing it through
    // a ternary argument loses the discriminant.
    const selection = this.props.selection
    const task: Cancellable<MatrixResult> =
      selection !== undefined && this.level === 'bin'
        ? client.cancellable<'selection'>(
            {
              kind: 'selection',
              unit: selection.kind,
              names: selection.names,
              balance,
              binsPerCell: this.stride,
            },
            onProgress,
          )
        : this.level === 'bin'
        ? client.cancellable<'matrix'>(
            {
              kind: 'matrix',
              rows,
              balance,
              // 1 asks for the ordinary dense read; above that the block comes
              // back at a coarser bin size, which is the one the panel was
              // built for.
              binsPerCell: this.stride,
              ...budget,
              ...genomes,
            },
            onProgress,
          )
        : client.cancellable<'aggregate'>(
            { kind: 'aggregate', rows, level: 'contig', balance, ...budget, ...genomes },
            onProgress,
          )
    this.running = task

    try {
      const result = await task.promise
      if (this.disposed || this.running !== task) return
      // The same three shapes, against the other file. Written out for the
      // reason the reads above are: a request type is a discriminated union and
      // narrowing it through a ternary argument loses the discriminant.
      const second = await secondBlock(this.props.compare, (other) =>
        selection !== undefined && this.level === 'bin'
          ? other.request<'selection'>({
              kind: 'selection',
              unit: selection.kind,
              names: selection.names,
              balance,
              binsPerCell: this.stride,
            })
          : this.level === 'bin'
          ? other.request<'matrix'>({
              kind: 'matrix',
              rows,
              balance,
              binsPerCell: this.stride,
              ...budget,
              ...genomes,
            })
          : other.request<'aggregate'>({
              kind: 'aggregate',
              rows,
              level: 'contig',
              balance,
              ...budget,
              ...genomes,
            }),
      )
      if (this.disposed || this.running !== task) return
      this.panel.setData(result, 'Whole genome', second)
      this.summary.textContent = this.summarise(result)
    } catch (err) {
      // `disposed` covers the case the others need a guard for: closing the map
      // puts the reader down, which rejects this read after the browser has
      // been mounted in this view's place.
      if (this.disposed || this.running !== task) return
      // A cancel is an answer, not a failure: `cancel` has already put the gate
      // back, so there is nothing to say here.
      if (isCancellation(err)) return
      // Too big is a fact about this machine, not a broken file: say it here,
      // above a level control that offers the version which does fit, rather
      // than on an error screen that offers a way back to the file picker.
      if (err instanceof ViewerError && err.code === 'dense-too-large') {
        this.panel.setBusy(false)
        this.showRefusal(err)
        return
      }
      this.props.onError(err)
    } finally {
      if (this.running === task) {
        this.running = null
        this.progressBox.classList.add('hidden')
      }
    }
  }

  /**
   * The line under the heading: what is on screen, and at what resolution.
   *
   * The resolution is the part that is new and the part a reader cannot get any
   * other way. It used to say "1 bin is 1 pixel" or, past the raster's cap, that
   * the *picture* was pooled and zooming would not sharpen it — a caveat about
   * the drawing. Now the pooling is in the data, so the sentence is about the
   * data: these cells are this many base pairs, and that is the map you are
   * reading. `poolingNote` still speaks for the raster, which pools again above
   * 4096 cells and, at this cap, never does.
   */
  private summarise(result: MatrixResult): string {
    const { nBins, noun, balance, selection } = this.props
    const raster = this.level === 'bin' ? poolingNote(result.nrows, result.ncols) : null
    const bins = selection?.bins ?? nBins
    const parts = [
      `${fmt.int(bins)} bins across ${fmt.int(result.rowGroups.length)} ${noun}s` +
        (selection === undefined ? '' : ` of ${fmt.int(nBins)}`),
      `${fmt.int(result.nrows)} × ${fmt.int(result.ncols)} cells`,
    ]
    if (this.level === 'bin') parts.push(this.resolutionPhrase(result.binsPerCell ?? 1))
    if (raster !== null) parts.push(raster.phrase)
    if (balance) parts.push('balanced')
    if (result.poolSnapped === false) {
      parts.push('cells may span two sequences, so positions in them are approximate')
    }
    return parts.join(' · ')
  }

  /**
   * A refusal, said where the map would have been, with what to do instead.
   *
   * Shared by the read and by the pre-flight, so the sentence a user meets
   * before clicking and the one they would have met after are the same
   * sentence.
   */
  private showRefusal(err: ViewerError): void {
    const { noun } = this.props
    // Only the *budget* refusal is overridable, and after the gate there is
    // nothing left to override: the confirmation already set the budget aside.
    // The CLI-parity limit, the single-array ceiling and a real allocation
    // failure are not opinions about this machine, so they get no button.
    const estimate = err.detail['bytes']
    const needed =
      err.detail['where'] === 'browser' && typeof estimate === 'number' ? estimate : null
    // "Switch to level" is a real escape hatch now. It used to be a false one:
    // the roll-up loaded the same bin-level block before summing it, so it was
    // refused by the same guard for the same reason. It accumulates from the
    // stored pixels instead, and its cost is the *output* size — one cell per
    // sequence pair, which always fits.
    this.problem.replaceChildren(
      el('span', {
        text:
          `${err.message} The ${noun}-level view of the same selection is one cell per ` +
          `${noun} and always fits; a coarser resolution of this file, if it has one, or a ` +
          `single ${noun} from the table, will too.`,
      }),
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
    this.gate.classList.add('hidden')
    this.panelHost.classList.add('hidden')
  }
}

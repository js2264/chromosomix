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

import { WHOLE_VIEW_GATE_PIXELS, WHOLE_VIEW_GATE_BINS } from '../constants'
import { IDENTITY_PLAN, POOLED_CELL_CAP, poolPlan, type PoolPlan } from '../metacooler/pooling'
import type { MatrixResult } from '../worker/protocol'
import type { Extent } from '../types'
import { isCancellation, type Cancellable, type ReaderClient } from '../worker/client'
import { ViewerError, isAllocationFailure } from '../errors'
import { typedLocusToRegion } from '../genome/assembly'
import { button, el, fmt, titleWhenCut } from './dom'
import { resolutionLabel } from '../units'
import type { ScaleState } from './GenomeView'
import {
  MatrixPanel,
  axisRegion,
  poolingNote,
  blockSummary,
  type AnnotationContext,
  type DerivePresentation,
  type TurnPresentation,
 type FigureSubject} from './MatrixPanel'
import { REMOTE_SCAN_BYTE_LIMIT, overviewTarget } from './Overview'
import { presentationOf, secondBlock, type CompareRead } from './compare'
import { attachRefine, rungsOf, type BlockLadder } from './refine'
import { scoreChoices, scoreFor, type ScoreChoice } from './scores'
import { SearchBox, featureSuggestions, locusPlaceholder } from './SearchBox'

export interface WholeViewProps {
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
  /**
   * Open the file at another rung, by entry name — the gate's second button.
   *
   * A whole-genome view pools the fine rung into cells hundreds of bins wide,
   * and a coarser rung of the same file draws the same cells from a fraction
   * of the pixels. Absent where the shell cannot switch rung, and the gate
   * then offers only the read.
   */
  onOpenRung?(entry: string): void
  /**
   * Present when this view is the `bin × bin` level of a metagenome's whole-file
   * picker (§7.3) rather than a view of its own.
   *
   * Four things follow from it, and they are one thing said four ways — *this
   * picture is of the whole metagenome*:
   *
   * - the picker is in the General column's Genomes card, at every level, or
   *   there is no way back to the other two (`Session.paintLevel`);
   * - the read is asked about first whatever the pixel count, because it is the
   *   landing level now and §7.3's rule is that a full pass is never automatic;
   * - the axis is labelled and divided by **genome**, which is what the other
   *   two levels do and what makes the three one picture at three depths;
   * - and so a label click opens a genome, since a genome name is not a region.
   *
   * Passed in rather than derived: this view does not know which of the three
   * levels it is, and the shell does.
   */
  wholeFileLevel?: {
    /** An axis label — a genome name here — was clicked. */
    onOpenGenome(genome: string): void
    /**
     * A cell between two genomes was clicked.
     *
     * The other half of {@link onOpenGenome}, and it is what makes this level
     * agree with the two beside it: on the contig × contig and genome × genome
     * pictures a click has always resolved to a *genome* — its own square on
     * the diagonal, the pair off it (`ui/Overview.ts`) — and here it resolved
     * to a contig, so the same gesture on the same file went somewhere else
     * depending on which of three levels the reader had chosen.
     */
    onOpenPair(rowGenome: string, colGenome: string): void
  }
  /** Total bins in the file, for the counts a selection is measured against. */
  nBins: number
  /**
   * The bins this view draws: everything but `__unbinned__` (§7.4).
   *
   * Not `[0, nBins)`. The unassigned contigs are not a genome, are absent from
   * every table and every other view, and on a real metagenome are the largest
   * thing in the file — drawing them here put a band across the picture and,
   * being among the drawn pixels, set the colour scale for everything else.
   */
  displayExtent: Extent
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
  selection?: { kind: 'genome' | 'contig'; names: string[]; bins: number; contigs: number }
  /**
   * Total sequences — the second number the grid is planned against.
   *
   * A plan needs both: `n / cap` bins per cell is only achievable while the
   * sequences are fewer than the cells, because every sequence starts a cell of
   * its own (`metacooler/pooling.ts`). Planning from the bin count alone is what
   * produced a block above the cap that the renderer then pooled a second time,
   * contig-blind, two cells to a pixel.
   */
  nContigs: number
  level: 'bin' | 'contig'
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
  /** What one axis unit is called here: a chromosome, or a contig. */
  noun: string
  /**
   * The assembly's first sequence name, for the locus box's example (§26.6).
   *
   * Absent on a file whose sequences this view has not been told about, and then
   * the builder writes the neutral word instead.
   */
  first?: string
  /**
   * Where the pixels come from, and how many bytes of them there are.
   *
   * The gate priced the read in stored pixels and said nothing about the
   * download, while the metagenome's gate next to it quoted the bytes and said
   * nothing about the pixels — and over a network the cost a lab pays is the
   * download (§7.3, §18.6). Both gates state both figures now, and this view
   * had neither of them.
   */
  sourceKind?: 'local' | 'remote'
  sourceBytes?: number
  /**
   * Ask the reader which genome each contig belongs to, for the tooltip.
   *
   * This is the one view where the answer is not already known from the view
   * itself: a genome view is one genome and a region view is one contig of one,
   * but here the axes run over the whole file and a contig's genome is exactly
   * the thing that is not on screen. False for a plain cooler, which has none.
   */
  namesGenomes: boolean
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
  /** A cell was clicked: open that sequence, or the block between two. */
  onOpenRegion(region: string, region2?: string): void
  /**
   * An axis label was clicked and that label is a **genome** name.
   *
   * Only reached where the axis is divided and labelled by genome, which for
   * this view means a selection of several of them ({@link selection}); the
   * whole-file picker has its own, beside the two other destinations it opens
   * ({@link wholeFileLevel}). Both go to the same place, and the split is only
   * that the picker hands over three callbacks and a selection needs one.
   *
   * Absent leaves the label opening as a *region*, which is not a broken path —
   * `parseMetacoolerRange` takes a bare genome name and the region view offers
   * the genome view from there. It is one screen longer than the gesture meant,
   * which is why this exists.
   */
  onOpenGenome?(genome: string): void
  onError(err: unknown): void
  /**
   * The bin-level read could not be given the memory it needs (§7.3).
   *
   * Handed to the shell rather than shown here, because the answer is another
   * level — the shell's to route — and a level this machine has just refused is
   * one the picker should stop offering. Absent, the failure is an ordinary
   * error.
   */
  onOutOfMemory?(): void
  /**
   * Start the read at once, past the gate: the reader has already agreed to a
   * pass over every pixel, at the level that just ran out of memory.
   */
  start?: boolean
  /**
   * Annotations to draw beside and on the map (spec §8).
   *
   * Every view that mounts a panel takes this now. It used to be this view and
   * the region view alone, on the grounds that a `.metacool` carries no
   * annotations (§8.5) and the genome, pair and overview views are reachable
   * only on files that have genomes — true of *files*, and no longer true of
   * annotations: a metacool's own columns are ones it cannot misplace (§8.12),
   * so the three views a metagenome is actually read in are exactly the ones
   * that had no way to draw them.
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
  caption?: FigureSubject
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
  private readonly plan: PoolPlan
  /** The bar, the count and the cancel — the whole-metagenome scan's, verbatim. */
  private readonly progressBar = el('progress', { class: 'progress' })
  private readonly progressText = el('span', { class: 'progress-text' })
  private readonly progressBox: HTMLElement
  /** The read in flight, so it can be called off. */
  private running: Cancellable<MatrixResult> | null = null
  private disposed = false
  /**
   * The zoom's own reader, once the gated pass has produced a picture.
   *
   * This is the view the whole feature is for: a whole file arrives pooled
   * — the note under it says by how much — and until now the only way to
   * sharpen it was to leave and open something smaller. The gate is
   * untouched: the full pass still runs once, on an explicit action, and
   * what the ladder adds is *bounded* reads inside the picture it produced,
   * never another pass over every pixel.
   */
  private ladder: BlockLadder | null = null
  /**
   * Whether the axis on screen is divided and labelled by **genome** — and so
   * whether an axis label is a genome name or a contig one.
   *
   * A fact about the block rather than about the view, because two views arrive
   * at it by different routes: the whole-file level sets the flag itself
   * ({@link byGenome}), and a map of several ticked genomes has it set by the
   * reader, which is the half that knows what was ticked. A boolean rather than
   * the block it is read off, so nothing here outlives the panel's own copy.
   */
  private axisIsGenomes = false

  constructor(private readonly props: WholeViewProps) {
    this.level = props.level
    // A selection is pooled against *its own* size: four MAGs are a small
    // picture however large the file they came out of is, and pooling them by
    // the file's stride would throw away the detail they were chosen for.
    const fitted =
      props.level === 'bin'
        ? poolPlan(
            props.selection?.bins ?? props.displayExtent[1] - props.displayExtent[0],
            props.selection?.contigs ?? props.nContigs,
            POOLED_CELL_CAP,
          )
        : IDENTITY_PLAN
    // **The reader's declared resolution is a floor, never a ceiling** (§3.4).
    // A whole genome at 10 kb is a picture; a whole genome at the 3 kb somebody
    // added for a locus view is a hundred thousand cells a side, which is not a
    // picture and which this view's own plan exists to refuse. So the coarser of
    // the two wins, the summary says which, and a reader who came here from a
    // 3 kb region view is told *cells of about 40 kb* rather than handed a
    // number that was quietly ignored.
    this.plan =
      fitted.contigsPerCell > 1
        ? fitted
        : { ...fitted, binsPerCell: Math.max(fitted.binsPerCell, props.binsPerCell ?? 1) }
    this.summary = el('p', { class: 'summary' })
    // One line under the title, with the whole of it in a tooltip where it is cut.
    titleWhenCut(this.summary)
    this.problem = el('p', { class: 'inline-error hidden' })
    const store = props.annotations?.store
    this.search = new SearchBox({
      // The shared builder (§26.6). Spelled out as a list of nouns, this one
      // came to 46 characters — `chromosome, chromosome:start-end, or a gene` —
      // in a box about 260 pixels wide, so it was cut mid-word at exactly the
      // clause that says a gene name works here, which is the clause a reader of
      // a whole-genome picture most wants.
      placeholder: locusPlaceholder({
        first: props.first,
        accepts: { sequence: true, gene: store !== undefined },
      }),
      go: true,
      title:
        `Open one ${props.noun}, or a range within it` +
        (store === undefined ? '. ' : ', or a gene from the starred model. ') +
        'The same box the / key opens.',
      // 1-based inclusive in, the machine form out (§26.1): what a reader types
      // here is what they read off the map, and the region reader behind this
      // takes cooler's half-open interval.
      onSubmit: (text) => {
        if (text !== '') props.onOpenRegion(typedLocusToRegion(text))
      },
      // What the comment on the title bar promises: a whole-genome map of a
      // mammal is three pixels per chromosome arm, so "go to MYC" has to be
      // answerable by typing.
      // `display`, for the reason the sequence bar's box takes it: this box
      // reads what it shows back through `typedLocusToRegion`.
      ...(store === undefined
        ? {}
        : { suggest: (text: string) => featureSuggestions(store, text, 'display') }),
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
      binsize: props.binsize * this.plan.binsPerCell,
      ...(props.caption === undefined ? {} : { caption: props.caption }),
      ...(props.annotations === undefined ? {} : { annotations: props.annotations }),
      ...(presentationOf(props.compare) === undefined
        ? {}
        : { compare: presentationOf(props.compare) }),
      detachedControls: true,
      hideTitle: true,
      initial: { ...props.scale, level: props.level },
      balance: props.balance,

      onScaleChange: (scale) => props.onScaleChange(scale),
      ...(props.derive === undefined ? {} : { derive: props.derive }),
      ...(props.turn === undefined ? {} : { turn: props.turn }),
      scores: {
        choices: scoreChoices(props),
        current: scoreFor(scoreChoices(props), props).id,
        onChange: (choice) => props.onScoreChange(choice),
      },
      // Reported, not acted on. Both of these change *what is read*, so they go
      // out to the URL and the shell brings back a view built for the answer —
      // which is also what decides whether the new read is one to ask about
      // first. Loading here as well was the second of two reads for one click.
      onCellClick: (_cell, groups, genomes) => {
        if (groups.row === undefined) return
        // **The whole-metagenome picture answers with a genome**, which is what
        // the two levels above it have always answered with (`ui/Overview.ts`).
        // Its cells are bins and its runs are contigs, but the thing a reader
        // is pointing at is a MAG — the axis is divided and labelled by genome
        // at this level — and a contig of a metagenome is rarely the question
        // and is one click further in.
        //
        // Through `overviewTarget`, so all three levels of the whole-file
        // picker decide by one rule: same genome on both axes is that genome's
        // own map, two genomes are the block between them, and no genome at all
        // — a cooler, which has none — falls through to the sequence, which is
        // what this view has always done.
        const whole = props.wholeFileLevel
        const target =
          whole === undefined
            ? null
            : overviewTarget({
                level: 'contig',
                rowLabel: groups.row.label,
                colLabel: groups.col?.label ?? groups.row.label,
                ...(genomes?.row === undefined ? {} : { rowGenome: genomes.row }),
                ...(genomes?.col === undefined ? {} : { colGenome: genomes.col }),
              })
        if (whole !== undefined && target !== null && target.kind === 'genome') {
          whole.onOpenGenome(target.genome)
          return
        }
        if (whole !== undefined && target !== null && target.kind === 'pair') {
          whole.onOpenPair(target.rowGenome, target.colGenome)
          return
        }
        if (groups.col !== undefined && groups.col.label !== groups.row.label) {
          props.onOpenRegion(groups.row.label, groups.col.label)
          return
        }
        props.onOpenRegion(groups.row.label)
      },
      // A label is a contig, except where the axis is divided by genome — the
      // whole-file level, and a map of several ticked genomes — and there it is
      // a genome name, which the genome view is the answer to.
      //
      // Dispatched on **what the axis is** rather than on which of the two
      // views this is (`labelTarget`). The old test asked the second question
      // and so had one answer for the picker and another for everything else,
      // which is how a picture divided and labelled by genome came to open its
      // labels as regions — a genome name is a legal range, so the click landed
      // one screen short of where it meant to go rather than failing.
      onLabelClick: (_axis, name) => {
        const whole = props.wholeFileLevel
        const opensGenomes = whole !== undefined || props.onOpenGenome !== undefined
        if (labelTarget({ axisIsGenomes: this.axisIsGenomes, opensGenomes }) === 'region') {
          props.onOpenRegion(name)
          return
        }
        // Called on their objects rather than through a lifted reference: these
        // are callbacks a caller wrote, and detaching one is a `this` a caller
        // did not agree to.
        if (whole !== undefined) whole.onOpenGenome(name)
        else props.onOpenGenome?.(name)
      },
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

    this.sideEl = el(
      'aside',
      { class: 'side' },
      ...this.panel.cards,
    )

    // There is no longer a size that defeats this view, so there are two
    // answers rather than three: this is worth asking about first, or it opens.
    if (this.gated()) {
      // The scan view's sentence, in the scan view's place, because at this
      // level the two are the same screen: a heading, what the read costs, and
      // the button that starts it.
      if (props.wholeFileLevel !== undefined) {
        this.summary.textContent =
          'One pass over every non-zero pixel, at the level chosen in the Genomes card.'
      }
      if (props.start === true) void this.load(Number.POSITIVE_INFINITY)
      else this.renderGate()
    } else void this.load()
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
    this.ladder?.destroy()
    this.ladder = null
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
   * Whether to ask before reading.
   *
   * The cost of every level is the same pass over the same pixels — the roll-up
   * and the pooled read differ only in what they add them into — so the question
   * is asked at any of them. What is no longer asked is anything about the
   * *block*: it is bounded now, and a bounded block is not a decision.
   *
   * Unconditional at the whole-file level, whatever the file declares. That one
   * is the landing view of a metagenome (§7.3), and the rule there is not "warn
   * when it looks expensive" but "a pass over every pixel never starts on its
   * own" — a threshold would make the rule hold on large files and lapse on the
   * small ones, which is the same as not having it. Everywhere else the
   * threshold stands: a bounded read nobody waits for is not worth a click.
   */
  private gated(): boolean {
    const { nnz, wholeFileLevel } = this.props
    if (wholeFileLevel !== undefined) return true
    // A file that states no pixel count is measured by its bins instead — a
    // `.hic` at 1 kb walks every block of the file whatever it declares.
    if (nnz === null) return this.props.nBins > WHOLE_VIEW_GATE_BINS
    return nnz > WHOLE_VIEW_GATE_PIXELS
  }

  /**
   * The coarsest rung of this file whose bins still fit in one drawn cell.
   *
   * That rung draws the picture this view is about to pool the fine one into,
   * from far fewer pixels. `null` for a file with no ladder, and for one whose
   * open rung is already the coarsest that fits.
   */
  private cheaperRung(): { name: string; binsize: number } | null {
    const cell = this.props.binsize * this.plan.binsPerCell
    const fits = rungsOf(this.props.rungs ?? []).filter(
      (rung) => rung.binsize > this.props.binsize && rung.binsize <= cell,
    )
    return fits.length === 0 ? null : fits[fits.length - 1]
  }

  /**
   * The ask-first screen: what the read costs, and the button that starts it.
   *
   * Stated in pixels and in the resolution they will be summed into, because
   * those are the two things a reader cannot see from here and would want:
   * how long this will take, and what the picture will be. The metagenome's
   * gate says the same two things in its own units.
   *
   * The count is dropped where the file does not declare one — the gate is
   * unconditional at the whole-file level and a file with no `nnz` still gets
   * it, so the sentence has to work without the number rather than the screen
   * going missing when it is absent.
   */
  private renderGate(): void {
    const { nnz, sourceBytes, sourceKind } = this.props
    const counted = nnz === null ? '' : ` — ${fmt.int(nnz)} of them —`
    // **And the bytes.** A remote cooler was offered `compute whole genome` with
    // its pixel count and no mention of the download, while the metagenome's
    // gate beside it quoted the bytes and nothing else: over a network the cost
    // a lab actually pays is the download, and the gate that was about to fetch
    // eighteen megabytes did not say so (§7.3, §18.6).
    const priced =
      sourceBytes === undefined
        ? ''
        : ` — ${fmt.bytes(sourceBytes)} ${sourceKind === 'remote' ? 'downloaded' : 'read'}`
    const rung = this.props.onOpenRung === undefined ? null : this.cheaperRung()
    const lines: HTMLElement[] = [
      el(
        'p',
        {},
        el('strong', {
          // `resolutionLabel`, not `fmt.bp`: a bin size is a round number by
          // construction (§26.2), and this sentence said `at 1.0 kb` under a
          // resolution chip saying `1 kb` and beside a File card saying
          // `1,000 bp` — three spellings of one number on one screen.
          text: `${this.wholeName()} at ${resolutionLabel(this.props.binsize)} reads every stored pixel of the file`,
        }),
        `${counted} and sums them into ${this.resolutionPhrase()}${priced}. Once per file; the ` +
          'picture is kept while it is open.' +
          // A selection reads the whole file too: the sequences it wants are
          // scattered through the pixels, so there is no smaller span to walk.
          (this.props.selection === undefined
            ? ''
            : ' A selection costs the same pass: its sequences are spread through the file.'),
      ),
    ]
    if (sourceKind === 'remote' && sourceBytes !== undefined && sourceBytes > REMOTE_SCAN_BYTE_LIMIT) {
      // The warning the metagenome's gate has always given, on the gate that
      // reads the same pixels of the same file. A caution with a way through, so
      // `--warn` and not `--danger` (§26.5) — the button is right below it.
      lines.push(
        el('p', {
          class: 'hint gate-warn',
          text:
            `Reading this file over HTTP means downloading all ${fmt.bytes(sourceBytes)} of it, ` +
            `which is past the ${fmt.bytes(REMOTE_SCAN_BYTE_LIMIT)} this page starts on a click.`,
        }),
      )
    }
    if (rung !== null) {
      lines.push(
        el(
          'p',
          {},
          el('strong', {
            text: `Opening the file at ${resolutionLabel(rung.binsize)} draws the same picture`,
          }),
          ` from far fewer pixels — the cells are ${this.resolutionPhrase().replace(/^cells of /, '')} ` +
            'either way, and every region after it opens quicker too.',
        ),
      )
    }
    this.gate.replaceChildren(
      ...lines,
      el(
        'div',
        { class: 'whole-gate-actions' },
        ...(rung === null
          ? []
          : [
              button(`open at ${resolutionLabel(rung.binsize)} instead`, () => this.props.onOpenRung?.(rung.name), {
                class: 'btn btn-primary',
              }),
            ]),
        button(`compute ${this.wholeName().toLowerCase()}`, () => this.compute(), { class: 'btn' }),
      ),
    )
    this.gate.classList.remove('hidden')
    this.panelHost.classList.add('hidden')
  }

  /**
   * What the whole file is called: a metagenome's is the whole *meta*genome,
   * which is what its crumb, its palette entry and its other two levels say.
   */
  private wholeName(): string {
    return this.props.wholeFileLevel === undefined ? 'Whole genome' : 'Whole metagenome'
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
    if (selection === undefined) return this.wholeName()
    const noun = selection.kind === 'genome' ? 'genomes' : `${this.props.noun}s`
    return selection.names.length <= 3
      ? selection.names.join(' × ')
      : `${fmt.int(selection.names.length)} ${noun}`
  }

  /**
   * `cells of about 3.0 kb`, or `cells of 2 contigs` where a cell is whole
   * sequences.
   *
   * The gate's half of what the summary says once the read is done — a sentence
   * fragment rather than the summary's phrase, because it is read inside "sums
   * them into …". It works from the plan rather than from a result, being the
   * thing said *before* anything has been read.
   *
   * Hence *about*. The plan is a bound the reader may coarsen: it divides the
   * bin count by the cell budget, and the reader then has to fit whole contigs
   * into whole cells without straddling a genome, which on a fragmented
   * assembly costs cells and buys them back by widening. On the reference
   * metagenome that is 41 kb planned against 50 kb read — a number the gate
   * used to state flatly, on a screen the reader then compared with the summary
   * a moment later.
   */
  private resolutionPhrase(): string {
    if (this.plan.contigsPerCell > 1) {
      return `cells of ${fmt.int(this.plan.contigsPerCell)} ${this.props.noun}s`
    }
    // A bin size takes `resolutionLabel` (§26.2). `fmt.bp` wrote `cells of
    // about 3.0 kb` beside a chip reading `1 kb`, and a reader looks for a
    // difference between `3.0 kb` and `3 kb` that is not there.
    return `cells of about ${resolutionLabel(this.props.binsize * this.plan.binsPerCell)}`
  }

  /**
   * The plan on the wire, with the identity left off.
   *
   * Both numbers are optional in the protocol and absent means one, so an
   * unpooled read carries nothing rather than two ones — which is also what
   * keeps the request a caller can read.
   */
  private wire(): { binsPerCell?: number; contigsPerCell?: number } {
    return {
      ...(this.plan.binsPerCell > 1 ? { binsPerCell: this.plan.binsPerCell } : {}),
      ...(this.plan.contigsPerCell > 1 ? { contigsPerCell: this.plan.contigsPerCell } : {}),
    }
  }

  private async load(budgetBytes?: number): Promise<void> {
    const { client, balance, namesGenomes } = this.props
    const rows: Extent = this.props.displayExtent
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
    // The denominator is named by whoever counted it. A read of a cell set is
    // counted in *cells* — it is one bounded read repeated per cell — and a bar
    // that called those pixels would report three hundred pixels for a map with
    // a million in it.
    const onProgress = (done: number, total: number, note?: string): void => {
      this.progressBar.value = total === 0 ? 0 : done / total
      const unit = note === 'summing cells' ? 'cells' : 'pixels'
      this.progressText.textContent = `${fmt.int(done)} of ${fmt.int(total)} ${unit}`
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
              ...this.wire(),
            },
            onProgress,
          )
        : this.level === 'bin'
        ? client.cancellable<'matrix'>(
            {
              kind: 'matrix',
              rows,
              balance,
              // An identity plan asks for the ordinary dense read; above that
              // the block comes back on the coarser grid the panel was built
              // for.
              ...this.wire(),
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
              ...this.wire(),
            })
          : this.level === 'bin'
          ? other.request<'matrix'>({
              kind: 'matrix',
              rows,
              balance,
              ...this.wire(),
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
      // The reader may have planned a coarser grid than the file's bins — a
      // whole chromosome at 10 kb is more cells than any picture holds — and
      // every coordinate on screen is the bin size times a cell offset, so the
      // panel is told before it is given the block.
      this.panel.setResolution(this.props.binsize * (result.binsPerCell ?? 1))
      this.panel.setData(this.byGenome(result), this.wholeName(), second)
      this.summary.replaceChildren(...this.summarise(result))
      this.armRefine(rows, result, budget)
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
      // The browser refused the block's memory. A coarser level is the answer,
      // and the shell is what routes levels (`Session.binRefused`).
      if (
        isAllocationFailure(err) &&
        this.level === 'bin' &&
        this.props.selection === undefined &&
        this.props.onOutOfMemory !== undefined
      ) {
        this.panel.setBusy(false)
        this.props.onOutOfMemory()
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
   * Let the zoom read inside the whole-file picture.
   *
   * Three things this deliberately does *not* do. It is not armed at contig
   * level or over a selection: a cell there is a whole sequence and there is no
   * finer grid under it. It does not send `this.wire()` — the plan this view
   * chose for the *whole file* is the answer to a different question, and a
   * window inside it deserves the finest grid its own cell count allows. (The
   * reader's **declared** resolution is not that plan and does travel, as the
   * `floor` below; it is a number somebody typed rather than one this view fitted,
   * and the worker snaps it to each sequence's own grid so panning holds it
   * still.) And it does not run another full pass: every read it makes is a
   * bounded window inside the extent the gate already allowed.
   */
  private armRefine(
    ceiling: Extent,
    result: MatrixResult,
    budget: { budgetBytes?: number },
  ): void {
    this.ladder?.destroy()
    this.ladder = null
    if (this.level !== 'bin' || this.props.selection !== undefined) return
    if ((result.contigsPerCell ?? 1) > 1) return
    const { client, balance, namesGenomes } = this.props
    const genomes = namesGenomes ? { genomes: true } : {}
    this.ladder = attachRefine({
      panel: this.panel,
      ceiling: { rows: ceiling, cols: ceiling },
      binsize: this.props.binsize,
      rungs: rungsOf(this.props.rungs ?? []),
      floor: () => this.props.binsPerCell ?? 1,
      read: (rows, cols, rung, binsPerCell) => {
        const own = client.cancellable<'matrix'>({
          kind: 'matrix',
          ...(rung === undefined ? {} : { rung }),
          ...(binsPerCell === undefined ? {} : { binsPerCell }),
          rows,
          cols,
          balance,
          ...budget,
          ...genomes,
        })
        return {
          cancel: own.cancel,
          promise: own.promise.then(async (block) => {
            const other = await secondBlock(this.props.compare, (client2) =>
              client2.request<'matrix'>({
                kind: 'matrix',
                ...(rung === undefined ? {} : { rung }),
                ...(binsPerCell === undefined ? {} : { binsPerCell }),
                rows,
                cols,
                balance,
                ...budget,
                ...genomes,
              }),
            )
            const primary = this.byGenome(block)
            return other === undefined ? { result: primary } : { result: primary, second: other }
          }),
        }
      },
      onInstalled: (block) => this.summary.replaceChildren(...this.summarise(block)),
      onError: (err) => {
        if (err instanceof ViewerError) this.showRefusal(err)
      },
    })
    this.ladder.adopt(this.byGenome(result))
  }

  /**
   * Mark the block's genome runs as the axis, where this is the whole-file
   * level.
   *
   * A presentation flag and not a second read: the reader already returns
   * `rowGenomes`/`colGenomes` for this block (it is asked for them by
   * `namesGenomes`, for the tooltip), and `separatorsFor` promotes them to the
   * drawn boundaries *and* the labels when this is set. So the change is which
   * of two run lists the picture is divided by, decided by the view that knows
   * what it is a picture of.
   *
   * Left off everywhere else on purpose. A whole-genome map of a cooler has no
   * genomes, and a map of a chosen handful of *contigs* is a picture of the
   * choice — its axis names what was ticked, which is the answer to "what did I
   * pick" and would be lost by coarsening to the genomes those contigs came
   * from. A selection of *genomes* is that same rule the other way up and the
   * reader decides it there, on the read that knows what was ticked
   * (`handleSelection`): the flag arrives set and this method passes it through.
   */
  private byGenome(result: MatrixResult): MatrixResult {
    const block =
      this.props.wholeFileLevel !== undefined &&
      result.rowGenomes !== undefined &&
      result.colGenomes !== undefined
        ? { ...result, genomeBoundaries: true }
        : result
    // Recorded here because this is the one place every block this view installs
    // passes through — the gated read, each rung of the ladder, and the block it
    // adopts — and because the question it answers, "what is a label here", is
    // the same question this method decides.
    this.axisIsGenomes = block.genomeBoundaries === true
    return block
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
  private summarise(result: MatrixResult): Array<string | HTMLElement> {
    const raster = this.level === 'bin' ? poolingNote(result.nrows, result.ncols) : null
    return [
      ...blockSummary(this.props.binsize, result, this.props.noun),
      ...(raster === null ? [] : [` · ${raster.phrase}`]),
      ' · ',
      this.panel.viewNote,
    ]
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

/**
 * Where a clicked axis label leads.
 *
 * One rule for both pictures that are divided by genome — the whole-file picker
 * and a map of several ticked genomes — because a label means the same thing in
 * both and a reader clicking one is asking the same question. It used to be
 * decided by which view was asking, which is how the two came to disagree.
 *
 * `opensGenomes` is the second half and not a formality: a view with nowhere to
 * take a genome name falls back to the region, which the range parser accepts
 * (§5.4's first rule) and the region view then offers the genome view from. A
 * label that did nothing would be worse than a label one screen from home.
 *
 * Exported for the test that pins it, beside the selection helpers below
 * `MatrixPanel` and for the same reason: the rule is arithmetic and the view it
 * is read in needs a canvas.
 */
export function labelTarget(axis: {
  /** The axis is divided and labelled by genome (`MatrixResult.genomeBoundaries`). */
  axisIsGenomes: boolean
  /** This view has somewhere to take a genome name. */
  opensGenomes: boolean
}): 'genome' | 'region' {
  return axis.axisIsGenomes && axis.opensGenomes ? 'genome' : 'region'
}

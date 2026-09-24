/**
 * The whole-metagenome overview (spec §7.3) — available, gated, never automatic.
 *
 * Two levels over the same scan: **genome × genome**, the phage-host and HGT
 * picture, and **contig × contig**, which is the same question one level down
 * for anyone who does not trust the binning. Both cost exactly one pass over
 * every non-zero pixel, so the level is chosen before the scan rather than
 * derived from it.
 *
 * The picker offers a third, **bin × bin**, which this class does not draw: the
 * shell routes it to `WholeView`'s pooled read of the same pixels. It belongs in
 * the same list because it answers the same question on a third axis, and it is
 * usually the one to answer it with. A contig cell sums a rectangle of
 * `length × length` and a metagenome's contigs span several orders of magnitude,
 * so the contig picture spends its width on the shortest sequences and its
 * colour range on the longest — on a real 48-MAG file, a third of the diagonal
 * comes out empty while one badly-assembled genome takes a quarter of the axis.
 * Bin cells are all the same size, so the scale means one thing everywhere.
 * See {@link WHOLE_FILE_LEVELS} for what each is for.
 *
 * This is the only operation in the app that costs the whole file: summing all
 * genome pairs is inherently a full pixel scan and there is no index that
 * shortcuts it (§4). So it is not the landing view, and it never starts on its
 * own:
 *
 * - **Local files:** an explicit click, a progress indicator, and a cancel that
 *   actually stops the scan (the worker checks between pixel chunks).
 * - **Remote files:** refused above a byte threshold, because a full scan over
 *   HTTP means downloading the file. Offered instantly when a sidecar edge list
 *   is advertised — `metacooler network --level genome` emits a
 *   `node1/node2/value` TSV that is a few KB for a few hundred MAGs, so one
 *   `fetch` replaces the scan entirely.
 *
 * Both routes are opportunistic in the same way the mmetacool ladder is: a plain
 * `.metacool` with no sidecar behaves identically, minus the overview.
 *
 * `__unbinned__` is excluded (§7.4), which is required and which incidentally
 * makes the picture readable — it otherwise dominates its own row and column.
 */

import type { AxisGroup, MatrixResult, OverviewResult } from '../worker/protocol'
import type { Cancellable, ReaderClient } from '../worker/client'
import { isCancellation } from '../worker/client'
import { button, el, fmt, titleWhenCut } from './dom'
import type { ScaleState } from './GenomeView'
import { MatrixPanel, blockSummary, type AnnotationContext } from './MatrixPanel'
import { SearchBox, locusPlaceholder } from './SearchBox'

/**
 * Above this, a remote full scan is refused outright. A scan reads every pixel,
 * so the honest description of "compute the overview remotely" is "download the
 * file"; past a few tens of megabytes that is not something to start on a click.
 */
export const REMOTE_SCAN_BYTE_LIMIT = 64 * 1024 * 1024

/**
 * The three axes the whole-file view of a metagenome can be drawn on.
 *
 * Two of them are this view's scan and the third is `WholeView`'s pooled read,
 * which is a fact about *which class the shell mounts* and not about the choice
 * being made — the reader is picking what one cell means, and "a 50 kb square",
 * "a contig pair" and "a genome pair" are three answers to that one question.
 * So they are one list, offered in one control, and `Session.mountOverview`
 * turns the answer into a view.
 */
export type WholeFileLevel = 'bin' | 'contig' | 'genome'

/**
 * What each level is called, and what one cell of it holds.
 *
 * Exported for the test that ties the two ends of the choice together: every
 * level offered here has to be one `overviewLevel` can return and one the hash
 * round-trips, or the picker offers a place the shell cannot route to. That is
 * the one failure a Node suite can catch in a control it has no document to
 * build.
 */
export const WHOLE_FILE_LEVELS: ReadonlyArray<{
  value: WholeFileLevel
  label: string
  hint: string
}> = [
  {
    value: 'bin',
    label: 'bin × bin',
    // The one level whose cells are all the same size, which is why it is the
    // legible picture of a fragmented assembly: a contig cell sums a rectangle
    // of `length × length`, and on a metagenome that spans several orders of
    // magnitude, so one colour scale cannot fit both ends of it.
    hint:
      'Every genome at once, on an axis of base pairs — equal-area cells, so the colour scale ' +
      'means the same thing everywhere. The same map as ticking every row of the genomes table.',
  },
  {
    value: 'contig',
    label: 'contig × contig',
    hint:
      'One cell per contig, so a block is as wide as a genome is fragmented rather than as long ' +
      'as it is. The picture to read when the question is whether a bin holds together.',
  },
  {
    value: 'genome',
    label: 'genome × genome',
    hint: 'One cell per genome pair: the phage–host and HGT picture, and the smallest of the three.',
  },
]

export interface OverviewProps {
  client: ReaderClient
  binsize: number
  sourceKind: 'local' | 'remote'
  sourceBytes: number
  /**
   * Stored pixels in the file, where it says — the other half of the price.
   *
   * The gate quoted bytes and the whole-genome gate beside it quoted pixels, so
   * the same read was priced in two currencies on two levels of one picker
   * (§7.3, §18.6). Both say both now. `undefined` where the file declares no
   * `nnz`, and then the sentence is written without it rather than going
   * missing.
   */
  nnz?: number
  /** What one axis unit is called here — a contig, or a chromosome (§26.4). */
  noun?: string
  /** Sidecar edge list advertised by a catalog, if any. */
  edgeListUrl?: string
  /**
   * Which axes to scan for, from the view state.
   *
   * Never `bin`: the shell routes that level to `WholeView` before this class is
   * built (`Session.mountOverview`), because it is a bounded read of the stored
   * pixels rather than an accumulation over unit pairs.
   */
  level: 'genome' | 'contig'
  /** The colour scale from the view state; the panel starts there. */
  scale: ScaleState
  onScaleChange(scale: ScaleState): void
  onOpenPair(rowGenome: string, colGenome: string): void
  /**
   * Every genome in this file, for the box in the heading.
   *
   * A name typed there is one or the other — a genome or a contig — and the two
   * open different views. The list is already in memory (the genomes table is
   * read at open), so the box can settle it here rather than navigate and let
   * the reader find out from an error.
   */
  genomeNames: string[]
  /** A cell within one genome, which is the genome view. */
  onOpenGenome(genome: string): void
  /**
   * The contig-level fallback, for a cell whose genome cannot be named — see
   * {@link Overview.openCell}. Not the ordinary route out of this view.
   */
  onOpenContig(rowContig: string, colContig?: string): void
  onError(err: unknown): void
  /**
   * Start the scan at once, past the gate: the reader has already agreed to a
   * pass over every pixel, at the bin level that just ran out of memory.
   */
  start?: boolean
  /**
   * Annotations to draw beside the map (§8, §8.12).
   *
   * The whole-metagenome picture is the one this matters most in: its axis is
   * MAGs, and a MAG's completeness, redundancy and taxon are exactly what a
   * reader is holding the picture against. No file's tracks can be drawn here —
   * a metacool loads none (§8.5) — so in practice this carries the file's own
   * columns and nothing else.
   */
  annotations?: AnnotationContext
  /** File and genome context for the exported figure's caption. */
  caption?: { file: string; genome?: string }
}

export class Overview {
  readonly el: HTMLElement
  /**
   * The view's own controls, mounted by the shell in the right-hand column
   * rather than inside this element — see `App.showContent`.
   */
  readonly sideEl: HTMLElement
  /**
   * The heatmap panel, exposed for the same reason {@link GenomeView} exposes
   * its own: the shell has to be able to reach it. Folding or dragging a side
   * panel changes how much room the plot has, and nothing inside the view can
   * observe that — so a view the shell cannot reach is a plot that stays the
   * size it was while the others follow the column.
   */
  readonly panel: MatrixPanel
  private readonly gate: HTMLElement
  private readonly progressBar: HTMLProgressElement
  private readonly progressText: HTMLElement
  private readonly progressBox: HTMLElement
  private readonly panelHost: HTMLElement
  private readonly summary: HTMLElement
  /** Where a genome is named; the `/` key puts the caret here. */
  private readonly search: SearchBox
  private running: Cancellable<OverviewResult> | null = null
  /**
   * Which scan the panel is currently willing to paint.
   *
   * Cancellation is cooperative and therefore *late*: the worker stops at the
   * next chunk boundary, and a scan already past its last chunk finishes and
   * posts a result regardless. Without this counter that result painted the
   * overview the user had just called off.
   */
  private generation = 0
  /**
   * The axes to scan for, which the view state owns and the shell builds this
   * view for: switching it is a new state, and a new state is a new view.
   *
   * It defaults to contigs rather than genomes — see `overviewLevel` — because
   * both cost the same single pass and the contig picture is the one that
   * *contains* the other: its blocks are the genomes, with the binning still
   * visible inside each one. A genome × genome cell has already thrown that
   * away, so starting there hides the question most people open this view to
   * ask, which is whether a bin holds together.
   */
  private level: 'genome' | 'contig'
  /**
   * The genome each axis entry belongs to, at contig level — the reader's
   * `groups`, kept because it is what a click resolves through.
   */
  private axisGenomes: string[] | undefined
  /** Slot index → the unit that slot starts at; see {@link openCell}. */
  private unitNames: string[] | null = null

  constructor(private readonly props: OverviewProps) {
    // The state gets the last word except where the offered route is a sidecar
    // edge list, which is genome-level by construction: the picker must not say
    // "contig × contig" over a button that can only produce the other one.
    this.level = props.edgeListUrl === undefined ? props.level : 'genome'
    this.gate = el('div', { class: 'gate' })
    this.progressBar = el('progress', { class: 'progress' })
    this.progressBar.max = 1
    this.progressText = el('span', { class: 'progress-text' })
    this.progressBox = el(
      'div',
      { class: 'progress-box hidden' },
      this.progressBar,
      this.progressText,
      button('cancel', () => this.cancel(), { class: 'btn btn-quiet' }),
    )
    this.panelHost = el('div', { class: 'overview-host hidden' })
    this.summary = el('p', { class: 'summary' })
    // One line under the title, with the whole of it in a tooltip where it is cut.
    titleWhenCut(this.summary)
    this.search = new SearchBox({
      // The shared builder (§26.6). This box takes a genome or a sequence and
      // nothing else, so that is what it lists — in the order and the grammar
      // every other locus box in the application uses.
      placeholder: locusPlaceholder({
        first: props.genomeNames[0],
        accepts: { sequence: true, genome: true },
      }),
      go: true,
      title:
        'Open one genome of this file by name. A name that is not a genome is tried as a ' +
        'contig, which is the other thing an axis of this map is made of.',
      onSubmit: (text) => {
        if (text === '') return
        if (this.props.genomeNames.includes(text)) this.props.onOpenGenome(text)
        else this.props.onOpenContig(text)
      },
    })

    // The same shape as the genome and region views: heading, summary, then the
    // plot with its controls in the sidebar. This view used to be laid out on
    // its own terms, which made switching to it feel like leaving the app.
    this.panel = new MatrixPanel({
      binsize: props.binsize,
      ...(props.annotations === undefined ? {} : { annotations: props.annotations }),
      ...(props.caption === undefined ? {} : { caption: props.caption }),
      detachedControls: true,
      hideTitle: true,
      initial: props.scale,
      onScaleChange: (scale) => props.onScaleChange(scale),
      onCellClick: (cell, groups) => this.openCell(cell, groups),
      // The axes of this view are labelled by *genome* at either level — the
      // reader's super-groups are what name a contig axis — so a label opens
      // the genome it names. The contig fallback is the one case where it does
      // not: an axis with no genome behind it is labelled by its contigs.
      onLabelClick: (_axis, name) => {
        if (this.level === 'genome' || this.axisGenomes !== undefined) {
          this.props.onOpenGenome(name)
        } else {
          this.props.onOpenContig(name)
        }
      },
      // A box across a whole-metagenome map is asking for a genome — there is
      // no smaller region an axis of aggregated units can name, and a cross-
      // genome square is still begun in one of them. Resolved through the
      // anchor rather than the block label, because at contig level the label
      // is a contig and the genome behind it is what this view is read by.
      onSelectRegion: (selection) => {
        const rows = this.axisGenomes?.[selection.anchor.row] ?? selection.rows.label
        const cols = this.axisGenomes?.[selection.anchor.col] ?? selection.cols.label
        // Across two genomes it is the pair — the phage-host and HGT block this
        // view exists to find — and within one it is that genome.
        if (rows === cols) this.props.onOpenGenome(rows)
        else this.props.onOpenPair(rows, cols)
      },
    })
    this.panelHost.appendChild(this.panel.el)

    this.el = el(
      'section',
      { class: 'view view-overview' },
      el(
        'header',
        { class: 'view-head' },
        el(
          'div',
          { class: 'title-bar' },
          el('h2', { text: 'Whole metagenome' }),
          // A metagenome's axis is thousands of MAGs, so the picture cannot be
          // aimed at: the cell for one genome of four thousand is a quarter of a
          // pixel. Naming it is the only way in, and this is the box `/` opens.
          this.search.el,
        ),
        this.summary,
      ),
      el('div', { class: 'overview-main' }, this.gate, this.progressBox, this.panelHost),
    )

    this.sideEl = el(
      'aside',
      { class: 'side' },
      ...this.panel.cards,
    )

    this.summary.textContent =
      'One pass over every non-zero pixel, at the level chosen in the Genomes card.'
    if (props.start === true && props.edgeListUrl === undefined) void this.scan()
    else this.renderGate()
  }

  /**
   * Adopt a colour scale the URL moved to (a shared link, the back button),
   * exactly as the genome and region views do.
   */
  applyScale(scale: ScaleState): void {
    this.panel.applyScale(scale)
  }

  /** The `/` key. */
  focusSearch(): void {
    this.search.focus()
  }

  destroy(): void {
    this.cancel()
    this.panel.destroy()
  }

  /**
   * §5.5 cross-navigation from an aggregated cell — **always to a genome**.
   *
   * This view is read by genome at either level: the blocks are the genomes and
   * the dividers mark them, so a cell is answered as "these two bins touch",
   * and the thing to open next is the pair. Off the diagonal that is the
   * genome × genome view — the phage–host lead this view exists for. Within one
   * genome the pair would be that genome with itself, which is just the genome
   * view, and its contigs are the axes there.
   *
   * At contig level that means the *contig* under the pointer decides nothing
   * beyond which genome it belongs to. Stepping from a 20,000-contig picture
   * straight into one 200 kb contig against another skips the level in between
   * and lands on a block too small to have been the reason for the click; the
   * genome view it goes to instead has the contig pair one further click away,
   * on a picture where it is legible.
   *
   * The contig route survives only where the genome cannot be named — a file
   * whose contigs carry no genome, where "open the genome" has no answer.
   */
  private openCell(
    cell: { row: number; col: number },
    groups: { row?: AxisGroup; col?: AxisGroup },
  ): void {
    if (groups.row === undefined || groups.col === undefined) return
    const names = this.unitNames
    const target = overviewTarget({
      level: this.level,
      rowLabel: unitAt(names, groups.row),
      colLabel: unitAt(names, groups.col),
      // Indexed by slot, and a slot is snapped to a genome boundary, so a
      // pooled row still belongs to exactly one genome — which is what makes
      // the genome route survive pooling unchanged.
      ...(this.axisGenomes === undefined
        ? {}
        : { rowGenome: this.axisGenomes[cell.row], colGenome: this.axisGenomes[cell.col] }),
    })
    switch (target.kind) {
      case 'genome':
        this.props.onOpenGenome(target.genome)
        break
      case 'pair':
        this.props.onOpenPair(target.rowGenome, target.colGenome)
        break
      case 'contig':
        this.props.onOpenContig(target.rowContig, target.colContig)
        break
    }
  }

  private renderGate(): void {
    const { sourceKind, sourceBytes, edgeListUrl } = this.props
    this.gate.replaceChildren()

    if (edgeListUrl !== undefined) {
      this.gate.appendChild(
        el('p', {
          text:
            'A genome-level edge list is published beside this file, so the overview is one small ' +
            'download instead of a full scan.',
        }),
      )
      this.gate.appendChild(button('load edge list', () => void this.loadSidecar()))
      return
    }

    if (sourceKind === 'remote' && sourceBytes > REMOTE_SCAN_BYTE_LIMIT) {
      // A warning with a way through, not a refusal.
      //
      // The threshold is a *bandwidth* judgement wearing a memory label: the
      // scan streams in bounded windows, so a 1 GB remote file costs the same
      // RAM as a 10 MB one and only the download is large. The operation is
      // already cancellable and already reports progress, and the sentence below
      // already states the cost honestly — which is exactly what a confirmation
      // needs and what an unconditional refusal wastes. The user knows their
      // connection; this page does not.
      // `--warn`, not `--danger`. The comment above says it: this is a caution
      // with a way through, and the button that goes through it is two lines
      // below. `inline-error` is the colour a refusal takes — a failed
      // validation row, an error view — so a reader who had learnt that red
      // means "this did not happen" read a refusal and had no reason to read on
      // (§26.5).
      this.gate.appendChild(
        el('p', {
          class: 'hint gate-warn',
          text:
            `Scanning this file over HTTP means downloading all ${fmt.bytes(sourceBytes)} of it, ` +
            `which is past the ${fmt.bytes(REMOTE_SCAN_BYTE_LIMIT)} this page starts on a click.`,
        }),
      )
      this.gate.appendChild(
        el('p', {
          class: 'hint',
          text:
            'Cheaper routes: open a local copy of the file, or publish a genome edge list next ' +
            'to it with `metacooler network --level genome --header` and reference it from the catalog.',
        }),
      )
      this.gate.appendChild(
        button(`download and scan anyway (${fmt.bytes(sourceBytes)})`, () => void this.scan(), {
          class: 'btn',
          title: 'The scan reports progress and can be cancelled at any point.',
        }),
      )
      return
    }

    // **The whole-genome gate's own sentence, and its own button.** §7.3 asks
    // that every level of the whole-file picture be gated behind the same
    // sentence and the same button, and these two were neither: one said
    // "This will read every pixel of the file (13.8 MB)" over a button reading
    // `compute overview`, the other quoted the pixel count and the cell size
    // over `compute whole genome` — so a reader switching level in one picker
    // watched the gate change shape, and a metagenomics reader who pressed
    // **whole genome** in the toolbar was asked to compute an *overview*, a word
    // that appears nowhere else on screen.
    //
    // Both figures, because a reader on a network pays the bytes and a reader on
    // a local disk pays the pixels, and the gate cannot know which of them is
    // reading.
    const price =
      this.props.nnz === undefined ? '' : ` — ${fmt.int(this.props.nnz)} of them —`
    const cell = this.level === 'genome' ? 'genome pair' : `${this.props.noun ?? 'contig'} pair`
    this.gate.appendChild(
      el(
        'p',
        {},
        el('strong', { text: 'The whole metagenome reads every stored pixel of the file' }),
        `${price} and sums them into one cell per ${cell} — ` +
          `${fmt.bytes(sourceBytes)} ${sourceKind === 'remote' ? 'downloaded' : 'read'}. ` +
          'Once per file; the picture is kept while it is open.',
      ),
    )
    this.gate.appendChild(button('compute whole metagenome', () => void this.scan()))
  }

  private cancel(): void {
    this.running?.cancel()
    this.running = null
    // Anything still in flight belongs to a generation the panel has left.
    this.generation += 1
    this.progressBox.classList.add('hidden')
    this.gate.classList.remove('hidden')
  }

  private async scan(): Promise<void> {
    this.gate.classList.add('hidden')
    this.progressBox.classList.remove('hidden')
    this.progressBar.value = 0
    this.progressText.textContent = 'starting…'

    const generation = ++this.generation
    const task = this.props.client.cancellable<'overview'>(
      { kind: 'overview', level: this.level },
      (done, total) => {
        if (generation !== this.generation) return
        this.progressBar.value = total === 0 ? 0 : done / total
        this.progressText.textContent = `${fmt.int(done)} of ${fmt.int(total)} pixels`
      },
    )
    this.running = task
    try {
      const result = await task.promise
      if (generation !== this.generation) return
      this.show(result)
    } catch (err) {
      if (generation !== this.generation) return
      if (isCancellation(err)) {
        this.progressText.textContent = 'cancelled'
        this.progressBox.classList.add('hidden')
        this.gate.classList.remove('hidden')
        return
      }
      this.props.onError(err)
    } finally {
      if (generation === this.generation) {
        this.running = null
        this.progressBox.classList.add('hidden')
      }
    }
  }

  private async loadSidecar(): Promise<void> {
    const url = this.props.edgeListUrl
    if (url === undefined) return
    this.gate.classList.add('hidden')
    this.progressBox.classList.remove('hidden')
    this.progressText.textContent = 'fetching edge list…'
    const generation = ++this.generation
    try {
      const result = await this.props.client.request<'overviewSidecar'>({
        kind: 'overviewSidecar',
        url,
      })
      if (generation !== this.generation) return
      this.show(result)
    } catch (err) {
      if (generation !== this.generation) return
      this.props.onError(err)
    } finally {
      if (generation === this.generation) this.progressBox.classList.add('hidden')
    }
  }

  private show(result: OverviewResult): void {
    this.axisGenomes = result.groups
    // The same two facts every other map carries, and nothing else. What the
    // rows hold is `2 contigs per cell, summed`, which the line already says;
    // saying it again underneath in a sentence was the note repeating the
    // summary at length. Where the numbers came from is not a property of the
    // picture — the gate above asked before the scan ran, and a sidecar edge
    // list is offered by name — so it is not a caption either.
    this.summary.replaceChildren(
      ...blockSummary(0, toMatrixResult(result), result.level === 'genome' ? 'genome' : 'contig'),
    )
    this.unitNames = result.unitNames
    this.panelHost.classList.remove('hidden')
    this.gate.classList.add('hidden')
    this.panel.setData(toMatrixResult(result), 'Whole metagenome')
  }
}

/**
 * The name a clicked slot stands for, as opposed to the name it displays.
 *
 * Once an axis is pooled these are two different strings. A pooled row reads
 * `NODE_7431 +15` — which is what a reader needs to see, and is not something to
 * hand to a range parser. `unitNames` holds the contig or genome each slot
 * *starts* at, indexed by slot, and `AxisGroup.start` is exactly that index. On
 * an unpooled axis the two agree, so the fallback is not a degraded path.
 */
export function unitAt(names: string[] | null | undefined, group: AxisGroup): string {
  return names?.[group.start] ?? group.label
}

/** Where a clicked overview cell leads. */
export type OverviewTarget =
  | { kind: 'genome'; genome: string }
  | { kind: 'pair'; rowGenome: string; colGenome: string }
  | { kind: 'contig'; rowContig: string; colContig?: string }

/**
 * Resolve a clicked cell to a view, at either level. See
 * {@link Overview.openCell} for why the answer is a genome even when the axes
 * are contigs; kept out of the class so it can be tested without a document.
 */
export function overviewTarget(cell: {
  level: 'genome' | 'contig'
  rowLabel: string
  colLabel: string
  /** The genome of each axis entry, at contig level. */
  rowGenome?: string
  colGenome?: string
}): OverviewTarget {
  const [row, col] =
    cell.level === 'contig' ? [cell.rowGenome, cell.colGenome] : [cell.rowLabel, cell.colLabel]
  if (row === undefined || col === undefined) {
    return cell.rowLabel === cell.colLabel
      ? { kind: 'contig', rowContig: cell.rowLabel }
      : { kind: 'contig', rowContig: cell.rowLabel, colContig: cell.colLabel }
  }
  return row === col ? { kind: 'genome', genome: row } : { kind: 'pair', rowGenome: row, colGenome: col }
}

/** Wrap an overview in the shape {@link MatrixPanel} draws. */
function toMatrixResult(result: OverviewResult): MatrixResult {
  const groups = result.labels.map((label, index) => ({ label, start: index, end: index + 1 }))
  const genomes = runsOf(result.groups)
  return {
    nrows: result.n,
    ncols: result.n,
    values: result.values,
    rowExtent: [0, result.n],
    colExtent: [0, result.n],
    rowGroups: groups,
    colGroups: groups,
    // This is the one view whose genome runs are also what gets drawn — see
    // `separatorsFor`. It is a picture *of* the genomes.
    ...(genomes === undefined
      ? {}
      : { rowGenomes: genomes, colGenomes: genomes, genomeBoundaries: true }),
    level: 'genome',
    // How many units a row holds, so the line under the map says it in the same
    // words every other view uses. An average — `poolUnits` gives the larger
    // genomes the larger shares — so it is rounded, and it is one when nothing
    // was pooled.
    ...(result.pooled ? { contigsPerCell: Math.max(2, Math.round(result.unitsPerSlot)) } : {}),
  }
}

/**
 * Consecutive runs of the same name, as axis groups.
 *
 * The contigs arrive in file order, which is grouped by genome (C4), so a run
 * *is* a genome's block. `undefined` in, `undefined` out: at genome level there
 * is no coarser structure to draw.
 */
function runsOf(names: string[] | undefined): AxisGroup[] | undefined {
  if (names === undefined || names.length === 0) return undefined
  const runs: AxisGroup[] = []
  let start = 0
  for (let i = 1; i <= names.length; i++) {
    if (i < names.length && names[i] === names[start]) continue
    runs.push({ label: names[start], start, end: i })
    start = i
  }
  return runs
}

/**
 * The whole-metagenome overview (spec §7.3) — available, gated, never automatic.
 *
 * Two levels over the same scan: **genome × genome**, the phage-host and HGT
 * picture, and **contig × contig**, which is the same question one level down
 * for anyone who does not trust the binning. Both cost exactly one pass over
 * every non-zero pixel, so the level is chosen before the scan rather than
 * derived from it.
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
import { button, el, fmt } from './dom'
import type { ScaleState } from './GenomeView'
import { MatrixPanel } from './MatrixPanel'

/**
 * Above this, a remote full scan is refused outright. A scan reads every pixel,
 * so the honest description of "compute the overview remotely" is "download the
 * file"; past a few tens of megabytes that is not something to start on a click.
 */
export const REMOTE_SCAN_BYTE_LIMIT = 64 * 1024 * 1024

export interface OverviewProps {
  client: ReaderClient
  binsize: number
  sourceKind: 'local' | 'remote'
  sourceBytes: number
  /** Sidecar edge list advertised by a catalog, if any. */
  edgeListUrl?: string
  /** Which axes to scan for, from the view state. */
  level: 'genome' | 'contig'
  /** The colour scale from the view state; the panel starts there. */
  scale: ScaleState
  /**
   * The level and the colour scale go back into the URL, exactly as they do
   * from every other heatmap view — which is the whole of what "the overview is
   * a view state" buys the reader.
   */
  onLevelChange(level: 'genome' | 'contig'): void
  onScaleChange(scale: ScaleState): void
  onOpenPair(rowGenome: string, colGenome: string): void
  /** A cell within one genome, which is the genome view. */
  onOpenGenome(genome: string): void
  /**
   * The contig-level fallback, for a cell whose genome cannot be named — see
   * {@link Overview.openCell}. Not the ordinary route out of this view.
   */
  onOpenContig(rowContig: string, colContig?: string): void
  onError(err: unknown): void
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
  private readonly note: HTMLElement
  private readonly levelSelect = el('select', { class: 'select' })
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
    this.note = el('p', { class: 'note hidden' })

    // The same shape as the genome and region views: heading, summary, then the
    // plot with its controls in the sidebar. This view used to be laid out on
    // its own terms, which made switching to it feel like leaving the app.
    this.panel = new MatrixPanel({
      binsize: props.binsize,
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
        el('div', { class: 'title-bar' }, el('h2', { text: 'Whole genome' })),
        this.summary,
        this.note,
      ),
      el('div', { class: 'overview-main' }, this.gate, this.progressBox, this.panelHost),
    )

    this.sideEl = el(
      'aside',
      { class: 'side' },
      this.panel.controlsEl,
      this.panel.plotEl,
      el(
        'section',
        { class: 'card' },
        el('h3', { text: 'Scan' }),
        this.levelPicker(),
        el('p', {
          class: 'hint',
          text:
            'Every other view costs a bounded read. This one costs a pass over every ' +
            'non-zero pixel, so it only runs when you ask for it.',
        }),
      ),
    )

    this.summary.textContent =
      'One pass over every non-zero pixel, at the level chosen on the right.'
    this.renderGate()
  }

  /**
   * Adopt a colour scale the URL moved to (a shared link, the back button),
   * exactly as the genome and region views do.
   */
  applyScale(scale: ScaleState): void {
    this.panel.applyScale(scale)
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

  /**
   * Genome or contig axes, chosen before the scan.
   *
   * The picker reports and does not decide: the level is in the URL like every
   * other view's, so the change goes out to the shell and comes back as a view
   * built for it. That is what makes the choice survive a shared link and a
   * back button, and it is the same round trip the transform and colormap take.
   *
   * Which also throws the result on screen away, as it must: the two levels are
   * different accumulations of the same pass, and there is no way to derive one
   * from the other without re-reading the pixels.
   */
  private levelPicker(): HTMLElement {
    const select = this.levelSelect
    select.appendChild(el('option', { value: 'genome', text: 'genome × genome' }))
    select.appendChild(el('option', { value: 'contig', text: 'contig × contig' }))
    select.value = this.level
    select.addEventListener('change', () => {
      this.props.onLevelChange(select.value as 'genome' | 'contig')
    })
    return el(
      'div',
      { class: 'field' },
      el('span', { class: 'field-label', text: 'level' }),
      select,
    )
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
      this.gate.appendChild(
        el('p', {
          class: 'inline-error',
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

    const cost =
      sourceKind === 'remote'
        ? `This will download the whole file (${fmt.bytes(sourceBytes)}).`
        : `This will read every pixel of the file (${fmt.bytes(sourceBytes)}).`
    this.gate.appendChild(el('p', { text: cost }))
    this.gate.appendChild(button('compute overview', () => void this.scan()))
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
    const unit = result.level === 'genome' ? 'genomes' : 'contigs'
    const provenance = result.source === 'scan' ? 'full scan' : 'edge list'
    const per = Math.round(result.unitsPerSlot)
    this.summary.textContent = result.pooled
      ? `${fmt.int(result.totalUnits)} ${unit} in ${fmt.int(result.n)} rows · ${provenance}`
      : `${fmt.int(result.n)} ${unit} · ${provenance}`
    this.unitNames = result.unitNames
    this.panelHost.classList.remove('hidden')
    this.gate.classList.add('hidden')
    this.panel.setData(toMatrixResult(result), 'Whole metagenome')

    // Three separate statements, composed rather than nested: the caveat used
    // to *replace* the click instruction, so the files most likely to carry one
    // — the big real ones — were the ones never told what a click does.
    //
    // The caveat itself no longer says a picture this size is "neither
    // renderable nor readable". Only the second half was ever true — the
    // renderer pools any raster to 4096 px per axis and draws it — and the first
    // half was the clause that justified throwing away 98% of the contigs.
    // Nothing is thrown away now, so it says what the rows *are* instead.
    const restriction = result.pooled
      ? `${fmt.int(result.totalUnits)} ${unit} are more than are readable at once, so each row sums ` +
        `about ${per} consecutive ${per === 1 ? unit.replace(/s$/, '') : unit}` +
        `${result.level === 'contig' ? ', never across a genome boundary' : ''}. ` +
        'Every one is included.'
      : ''
    this.note.classList.remove('hidden')
    this.note.replaceChildren(
      el('span', { text: [restriction].filter((part) => part !== '').join(' ') }),
    )
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

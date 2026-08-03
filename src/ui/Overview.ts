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
  onOpenPair(rowGenome: string, colGenome: string): void
  /** A cell within one genome, which is the genome view. */
  onOpenGenome(genome: string): void
  /**
   * The contig-level fallback, for a cell whose genome cannot be named — see
   * {@link Overview.openCell}. Not the ordinary route out of this view.
   */
  onOpenContig(rowContig: string, colContig?: string): void
  onError(err: unknown): void
}

export class Overview {
  readonly el: HTMLElement
  private readonly gate: HTMLElement
  private readonly progressBar: HTMLProgressElement
  private readonly progressText: HTMLElement
  private readonly progressBox: HTMLElement
  private readonly panelHost: HTMLElement
  private readonly summary: HTMLElement
  private readonly note: HTMLElement
  private readonly panel: MatrixPanel
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
   * Contigs, not genomes.
   *
   * Both cost the same single pass, and the contig picture is the one that
   * *contains* the other: its blocks are the genomes — the reader sends them as
   * a super-group and they are what the dividers mark — with the binning still
   * visible inside each one. A genome × genome cell has already thrown that
   * away, so starting there hides the question most people open this view to
   * ask, which is whether a bin holds together.
   */
  private level: 'genome' | 'contig' = 'contig'
  /**
   * The genome each axis entry belongs to, at contig level — the reader's
   * `groups`, kept because it is what a click resolves through.
   */
  private axisGenomes: string[] | undefined

  constructor(private readonly props: OverviewProps) {
    // Except where the offered route is a sidecar edge list, which is
    // genome-level by construction: the picker must not say "contig × contig"
    // over a button that can only produce the other one.
    if (props.edgeListUrl !== undefined) this.level = 'genome'
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
      detachedControls: true,
      hideTitle: true,
      onCellClick: (cell, groups) => this.openCell(cell, groups),
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
      el(
        'div',
        { class: 'genome-body' },
        el('div', { class: 'overview-main' }, this.gate, this.progressBox, this.panelHost),
        el(
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
        ),
      ),
    )

    this.summary.textContent =
      'One pass over every non-zero pixel, at the level chosen on the right.'
    this.renderGate()
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
    const target = overviewTarget({
      level: this.level,
      rowLabel: groups.row.label,
      colLabel: groups.col.label,
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
   * Switching level after a result discards it: the two levels are different
   * accumulations of the same pass, and there is no way to derive one from the
   * other without re-reading the pixels.
   */
  private levelPicker(): HTMLElement {
    const select = el('select', { class: 'select' })
    select.appendChild(el('option', { value: 'genome', text: 'genome × genome' }))
    select.appendChild(el('option', { value: 'contig', text: 'contig × contig' }))
    select.value = this.level
    select.addEventListener('change', () => {
      this.level = select.value as 'genome' | 'contig'
      // The result on screen was accumulated for the other level and cannot be
      // converted into this one without re-reading the pixels, so it goes.
      this.panelHost.classList.add('hidden')
      this.note.classList.add('hidden')
      this.gate.classList.remove('hidden')
      this.renderGate()
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
      this.gate.appendChild(
        el('p', {
          class: 'inline-error',
          text:
            `Refusing to scan a remote file of ${fmt.bytes(sourceBytes)}: reading every pixel over ` +
            `HTTP means downloading all of it. The limit is ${fmt.bytes(REMOTE_SCAN_BYTE_LIMIT)}.`,
        }),
      )
      this.gate.appendChild(
        el('p', {
          class: 'hint',
          text:
            'Two ways round it: open a local copy of the file, or publish a genome edge list next ' +
            'to it with `metacooler network --level genome --header` and reference it from the catalog.',
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
    this.summary.textContent = result.restricted
      ? `${result.n} densest ${unit} of ${result.totalUnits} · ${provenance}`
      : `${result.n} ${unit} · ${provenance}`
    this.panelHost.classList.remove('hidden')
    this.gate.classList.add('hidden')
    this.panel.setData(toMatrixResult(result), 'metagenome-overview')

    // Three separate statements, composed rather than nested: the restriction
    // caveat used to *replace* the click instruction, so the files most likely
    // to be capped — the big real ones — were the ones never told what a click
    // does.
    const restriction = result.restricted
      ? `A ${result.totalUnits} × ${result.totalUnits} picture is neither renderable nor readable, so the ` +
        `${result.n} ${unit} with the most non-zero pixels are shown.`
      : ''
    const click =
      result.level === 'genome'
        ? 'Click an off-diagonal cell to open that genome pair, or a diagonal cell to open the genome.'
        : 'Click a cell between two genome blocks to open that genome pair, or one inside a block to ' +
          'open the genome.'
    const excluded =
      result.level === 'genome'
        ? '__unbinned__ is excluded, as everywhere.'
        : 'Contigs of __unbinned__ are excluded, as everywhere.'
    this.note.classList.remove('hidden')
    this.note.replaceChildren(
      el('span', { text: [restriction, click, excluded].filter((part) => part !== '').join(' ') }),
    )
  }
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
  const superGroups = runsOf(result.groups)
  return {
    nrows: result.n,
    ncols: result.n,
    values: result.values,
    rowExtent: [0, result.n],
    colExtent: [0, result.n],
    rowGroups: groups,
    colGroups: groups,
    ...(superGroups === undefined
      ? {}
      : { rowSuperGroups: superGroups, colSuperGroups: superGroups }),
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

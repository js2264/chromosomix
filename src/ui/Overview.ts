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
  /** A diagonal cell: one genome with itself, which is the genome view. */
  onOpenGenome(genome: string): void
  /** A contig-level cell: one contig, or the block between two. */
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
  private level: 'genome' | 'contig' = 'genome'

  constructor(private readonly props: OverviewProps) {
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
      onCellClick: (_cell, groups) => this.openCell(groups),
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

  /** §5.5 cross-navigation from an aggregated cell. */
  private openCell(groups: { row?: AxisGroup; col?: AxisGroup }): void {
    if (groups.row === undefined || groups.col === undefined) return
    const row = groups.row.label
    const col = groups.col.label
    // Off the diagonal a cell is the *pair* — the phage-host lead this view
    // exists for. On the diagonal the pair would be a genome with itself, which
    // is just the genome, so open that instead of a degenerate pair view.
    if (this.level === 'contig') {
      this.props.onOpenContig(row, row === col ? undefined : col)
      return
    }
    if (row === col) this.props.onOpenGenome(row)
    else this.props.onOpenPair(row, col)
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
    this.progressBox.classList.add('hidden')
    this.gate.classList.remove('hidden')
  }

  private async scan(): Promise<void> {
    this.gate.classList.add('hidden')
    this.progressBox.classList.remove('hidden')
    this.progressBar.value = 0
    this.progressText.textContent = 'starting…'

    const task = this.props.client.cancellable<'overview'>(
      { kind: 'overview', level: this.level },
      (done, total) => {
        this.progressBar.value = total === 0 ? 0 : done / total
        this.progressText.textContent = `${fmt.int(done)} of ${fmt.int(total)} pixels`
      },
    )
    this.running = task
    try {
      this.show(await task.promise)
    } catch (err) {
      if (isCancellation(err)) {
        this.progressText.textContent = 'cancelled'
        this.progressBox.classList.add('hidden')
        this.gate.classList.remove('hidden')
        return
      }
      this.props.onError(err)
    } finally {
      this.running = null
      this.progressBox.classList.add('hidden')
    }
  }

  private async loadSidecar(): Promise<void> {
    const url = this.props.edgeListUrl
    if (url === undefined) return
    this.gate.classList.add('hidden')
    this.progressBox.classList.remove('hidden')
    this.progressText.textContent = 'fetching edge list…'
    try {
      this.show(await this.props.client.request<'overviewSidecar'>({ kind: 'overviewSidecar', url }))
    } catch (err) {
      this.props.onError(err)
    } finally {
      this.progressBox.classList.add('hidden')
    }
  }

  private show(result: OverviewResult): void {
    const unit = result.level === 'genome' ? 'genomes' : 'contigs'
    const provenance = result.source === 'scan' ? 'full scan' : 'edge list'
    this.summary.textContent = result.restricted
      ? `${result.n} densest ${unit} of ${result.totalUnits} · ${provenance}`
      : `${result.n} ${unit} · ${provenance}`
    this.panelHost.classList.remove('hidden')
    this.gate.classList.add('hidden')
    this.panel.setData(toMatrixResult(result), '')

    this.note.classList.remove('hidden')
    this.note.replaceChildren(
      el('span', {
        text: result.restricted
          ? `A ${result.totalUnits} × ${result.totalUnits} picture is neither renderable nor readable, so the ` +
            `${result.n} ${unit} with the most non-zero pixels are shown. __unbinned__ is excluded, as everywhere.`
          : result.level === 'genome'
            ? 'Click an off-diagonal cell to open that genome pair, or a diagonal cell to open the genome. ' +
              '__unbinned__ is excluded, as everywhere.'
            : 'Click a cell to open that contig, or the block between two contigs. ' +
              'Contigs of __unbinned__ are excluded, as everywhere.',
      }),
    )
  }
}

/** Wrap an overview in the shape {@link MatrixPanel} draws. */
function toMatrixResult(result: OverviewResult): MatrixResult {
  const groups = result.labels.map((label, index) => ({ label, start: index, end: index + 1 }))
  return {
    nrows: result.n,
    ncols: result.n,
    values: result.values,
    rowExtent: [0, result.n],
    colExtent: [0, result.n],
    rowGroups: groups,
    colGroups: groups,
    level: 'genome',
  }
}

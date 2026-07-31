/**
 * The genome × genome overview (spec §7.3) — available, gated, never automatic.
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

import type { MatrixResult, OverviewResult } from '../worker/protocol'
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
  onError(err: unknown): void
}

export class Overview {
  readonly el: HTMLElement
  private readonly gate: HTMLElement
  private readonly progressBar: HTMLProgressElement
  private readonly progressText: HTMLElement
  private readonly progressBox: HTMLElement
  private readonly panelHost: HTMLElement
  private panel: MatrixPanel | null = null
  private running: Cancellable<OverviewResult> | null = null

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
    this.panelHost = el('div', { class: 'overview-host' })

    this.el = el(
      'section',
      { class: 'view view-overview' },
      el(
        'header',
        { class: 'view-head' },
        el('h2', { text: 'Genome × genome overview' }),
        el('p', {
          class: 'hint',
          text:
            'Every other view in this app costs a bounded read. This one costs a pass over ' +
            'every non-zero pixel, so it only runs when you ask for it.',
        }),
      ),
      this.gate,
      this.progressBox,
      this.panelHost,
    )

    this.renderGate()
  }

  destroy(): void {
    this.cancel()
    this.panel?.destroy()
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

    const task = this.props.client.cancellable<'overview'>({ kind: 'overview' }, (done, total) => {
      this.progressBar.value = total === 0 ? 0 : done / total
      this.progressText.textContent = `${fmt.int(done)} of ${fmt.int(total)} pixels`
    })
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
    if (this.panel === null) {
      this.panel = new MatrixPanel({
        binsize: this.props.binsize,
        onCellClick: (_cell, groups) => {
          if (groups.row === undefined || groups.col === undefined) return
          if (groups.row.label === groups.col.label) return
          // §5.5: an off-diagonal cell in an aggregated view opens the pair it
          // stands for — which is exactly the phage–host lead this view is for.
          this.props.onOpenPair(groups.row.label, groups.col.label)
        },
      })
      this.panelHost.appendChild(this.panel.el)
    }

    const title = result.restricted
      ? `${result.n} densest genomes of ${result.totalGenomes} (${result.source === 'scan' ? 'full scan' : 'edge list'})`
      : `${result.n} genomes (${result.source === 'scan' ? 'full scan' : 'edge list'})`
    this.panel.setData(toMatrixResult(result), title)

    this.panelHost.querySelector('.overview-note')?.remove()
    this.panelHost.appendChild(
      el('p', {
        class: 'hint overview-note',
        text: result.restricted
          ? `A ${result.totalGenomes} × ${result.totalGenomes} picture is neither renderable nor readable, so the ` +
            `${result.n} genomes with the most non-zero pixels are shown. __unbinned__ is excluded, as everywhere.`
          : 'Click an off-diagonal cell to open that genome pair. __unbinned__ is excluded, as everywhere.',
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

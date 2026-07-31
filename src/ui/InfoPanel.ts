/**
 * The file info panel: attributes, metadata, the unassigned QC statistic, and
 * the performance counters.
 *
 * Three things here are specified rather than chosen.
 *
 * **The unassigned statistic (§7.4).** The fraction of contigs and bins that
 * binning failed to assign is shown once, as a read-only number, phrased as
 * `unassigned: 1,204 contigs / 8.3% of bins`. It is a direct diagnostic of
 * binning quality; a metagenomics reader will look for it and a reviewer will
 * expect it. It is a *number, not a view*: it opens nothing, selects nothing,
 * and is not a row in any table. It is the sole exception to `__unbinned__`
 * being invisible, and no code path reaches the reserved genome through it —
 * this panel receives four integers, not an index.
 *
 * **The counters (§12).** Request and byte counts, per view change and in
 * total, instrumented from the first commit because they are also a paper
 * figure. If the open path ever starts costing dozens of requests, this is where
 * it shows.
 *
 * **Deep validation (§6.3).** The full Python `validate()` reads whole columns
 * and pixel windows. Fine on local disk, not fine over HTTP, so it is an
 * explicit button and never automatic.
 */

import type { OpenResult, StatsResult } from '../worker/protocol'
import type { ReaderClient } from '../worker/client'
import { button, el, fmt } from './dom'

export interface InfoPanelProps {
  client: ReaderClient
  info: OpenResult
}

export class InfoPanel {
  readonly el: HTMLElement
  private readonly statsBody: HTMLElement
  private readonly validationBox: HTMLElement

  constructor(private readonly props: InfoPanelProps) {
    this.statsBody = el('div', { class: 'kv' })
    this.validationBox = el('div', { class: 'validation' })

    const validate = button('run deep validation', () => void this.runValidation(), {
      title:
        'Reads whole columns and pixel windows, exactly as `metacooler check --deep` does. ' +
        'Cheap on a local file, expensive over the network — so it is never automatic.',
    })

    this.el = el(
      'aside',
      { class: 'info-panel' },
      el('h3', { text: 'File' }),
      this.fileTable(),
      this.unassignedBlock(),
      this.metadataBlock(),
      el('h3', { text: 'Reads' }),
      this.statsBody,
      el('h3', { text: 'Validation' }),
      el('p', {
        class: 'hint',
        text: 'Light checks ran at open: attributes, group presence, table lengths, the /chroms soft link.',
      }),
      validate,
      this.validationBox,
    )

    this.refreshStats()
  }

  /** Poll the worker's counters; called after every view change. */
  refreshStats(): void {
    void this.props.client
      .request<'stats'>({ kind: 'stats' })
      .then((stats) => this.renderStats(stats))
      .catch(() => {
        /* counters are diagnostics; never let them break a view */
      })
  }

  private fileTable(): HTMLElement {
    const { info } = this.props
    const rows: Array<[string, string]> = [
      ['uri', info.uri],
      ['layout', info.layout.kind],
      ['source', info.sourceKind === 'local' ? `local file (${fmt.bytes(info.sourceBytes)})` : `remote (${fmt.bytes(info.sourceBytes)})`],
      ['bin size', info.binsize === null ? '—' : `${fmt.int(info.binsize)} bp`],
      ['bin type', String(info.info['bin-type'] ?? '—')],
      ['ordering', String(info.info['ordering'] ?? '—')],
      ['storage mode', String(info.info['storage-mode'] ?? '—')],
      ['assembly', String(info.info['assembly'] ?? '—')],
      ['format', `${String(info.info['format'] ?? '—')} v${String(info.info['format-version'] ?? '?')}`],
      ['genomes', fmt.int(info.nGenomes)],
      ['contigs', fmt.int(info.nContigs)],
      ['bins', fmt.int(info.nBins)],
      ['non-zero pixels', info.info['nnz'] === null || info.info['nnz'] === undefined ? '—' : fmt.int(Number(info.info['nnz']))],
      ['sum', info.info['sum'] === null || info.info['sum'] === undefined ? '—' : fmt.int(Number(info.info['sum']))],
    ]
    return el('div', { class: 'kv' }, ...rows.flatMap(([key, value]) => keyValue(key, value)))
  }

  /**
   * The single retained `__unbinned__` number, labelled as a QC statistic and
   * not as a genome.
   */
  private unassignedBlock(): HTMLElement {
    const stats = this.props.info.unassigned
    if (stats === null) {
      return el(
        'div',
        { class: 'qc qc-clean' },
        el('h3', { text: 'Binning QC' }),
        el('p', { text: 'This file has no __unbinned__ genome: every contig was assigned to a bin.' }),
      )
    }
    const contigFraction = stats.totalContigs === 0 ? 0 : stats.contigs / stats.totalContigs
    const binFraction = stats.totalBins === 0 ? 0 : stats.bins / stats.totalBins
    return el(
      'div',
      { class: 'qc' },
      el('h3', { text: 'Binning QC' }),
      el('p', {
        class: 'qc-stat',
        text: `unassigned: ${fmt.int(stats.contigs)} contigs / ${fmt.pct(binFraction)} of bins`,
      }),
      el('p', {
        class: 'hint',
        text:
          `${fmt.pct(contigFraction)} of contigs and ${fmt.int(stats.bins)} of ${fmt.int(stats.totalBins)} bins ` +
          'belong to __unbinned__. Unassigned contigs are not a genome and cannot be displayed; ' +
          'this number is a diagnostic of binning quality only.',
      }),
    )
  }

  private metadataBlock(): HTMLElement {
    const metadata = this.props.info.metadata
    if (metadata === null || Object.keys(metadata).length === 0) {
      return el('div', { class: 'meta-empty' }, el('h3', { text: 'Metadata' }), el('p', { class: 'hint', text: 'No metadata was stored in this file.' }))
    }
    return el(
      'details',
      { class: 'meta' },
      el('summary', { text: 'Metadata' }),
      el('pre', { class: 'json', text: JSON.stringify(metadata, null, 2) }),
    )
  }

  private renderStats(stats: StatsResult): void {
    this.statsBody.replaceChildren(
      ...keyValue('requests, total', fmt.int(stats.total.requests)),
      ...keyValue('bytes, total', fmt.bytes(stats.total.bytes)),
      ...keyValue('requests, last view', fmt.int(stats.lastOp.requests)),
      ...keyValue('bytes, last view', fmt.bytes(stats.lastOp.bytes)),
      ...keyValue('worker calls', fmt.int(stats.calls)),
    )
  }

  private async runValidation(): Promise<void> {
    this.validationBox.replaceChildren(el('p', { class: 'hint', text: 'scanning…' }))
    try {
      const result = await this.props.client.request<'validateDeep'>({ kind: 'validateDeep' })
      this.validationBox.replaceChildren(
        el('p', {
          class: result.ok ? 'ok' : 'inline-error',
          text: result.ok ? `No problems found. ${result.note}` : `${result.problems.length} problem(s) found.`,
        }),
        ...result.problems.map((problem) => el('p', { class: 'inline-error', text: problem })),
      )
      this.refreshStats()
    } catch (err) {
      this.validationBox.replaceChildren(
        el('p', { class: 'inline-error', text: err instanceof Error ? err.message : String(err) }),
      )
    }
  }
}

function keyValue(key: string, value: string): HTMLElement[] {
  return [el('div', { class: 'k', text: key }), el('div', { class: 'v', text: value, title: value })]
}

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
 * The §12 read counters and the §6.3 deep-validation control used to live here
 * too. They moved to the status bar: both are glanced at rather than read, and
 * a sidebar block spends permanent vertical space on something a single line
 * can carry.
 *
 * **The record host** is the one part of this panel that changes as you
 * navigate: the `/genomes` or `/contigs` row of whatever heatmap is on screen
 * ({@link RecordCard}). It sits directly under the File card, because those two
 * are what the reader is actually looking at — this file, this genome — while
 * the QC statistic and the stored metadata are consulted once and then ignored.
 * Those two stay last, in that order, wherever the record card is.
 */

import type { OpenResult } from '../worker/protocol'
import { el, fmt } from './dom'
import { recordCard, type RecordSpec } from './RecordCard'

export interface InfoPanelProps {
  info: OpenResult
}

export class InfoPanel {
  readonly el: HTMLElement
  /** Empty on a table view; `:empty` in the stylesheet is what hides it. */
  private readonly recordHost = el('div', { class: 'record-host' })

  constructor(private readonly props: InfoPanelProps) {
    this.el = el(
      'aside',
      { class: 'info-panel' },
      el('div', { class: 'card' }, el('h3', { text: 'File' }), this.fileTable()),
      this.recordHost,
      this.unassignedBlock(),
      this.metadataBlock(),
    )
  }

  /**
   * Show the table row(s) behind the current view, or nothing at all.
   *
   * Called on every render, including with `[]`: a genome card left standing
   * over the genomes table would describe a heatmap that is no longer there.
   */
  setRecords(records: RecordSpec[]): void {
    this.recordHost.replaceChildren(...records.map(recordCard))
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
      // A cooler has no genome layer, and a row reading "genomes 0" invites the
      // question of where they went. It is the contigs — cooler's chroms — that
      // this file is made of.
      ...(info.hasGenomes
        ? ([['genomes', fmt.int(info.nGenomes)]] as Array<[string, string]>)
        : []),
      [info.hasGenomes ? 'contigs' : 'chromosomes', fmt.int(info.nContigs)],
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
  private unassignedBlock(): HTMLElement | null {
    // A cooler was never binned, so there is no binning to report on — clean or
    // otherwise. Saying "every contig was assigned to a bin" about a file with
    // no bins is a false statement, not a reassuring one.
    if (!this.props.info.hasGenomes) return null
    const stats = this.props.info.unassigned
    if (stats === null) {
      return el(
        'div',
        { class: 'qc qc-clean' },
        el('h4', { class: 'qc-head', text: 'Binning QC' }),
        el('p', { text: 'This file has no __unbinned__ genome: every contig was assigned to a bin.' }),
      )
    }
    const contigFraction = stats.totalContigs === 0 ? 0 : stats.contigs / stats.totalContigs
    const binFraction = stats.totalBins === 0 ? 0 : stats.bins / stats.totalBins
    return el(
      'div',
      { class: 'qc' },
      el('h4', { class: 'qc-head', text: 'Binning QC' }),
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


}

function keyValue(key: string, value: string): HTMLElement[] {
  return [el('div', { class: 'k', text: key }), el('div', { class: 'v', text: value, title: value })]
}
